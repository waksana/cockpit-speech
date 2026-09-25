import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function sourceIdentity(root, strict = false) {
  let sha;
  try { sha = git(root, ['rev-parse', '--verify', 'HEAD']); }
  catch {
    if (strict) throw new Error('Commit the initial module source before packaging');
    git(root, ['rev-parse', '--show-toplevel']);
    return null;
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Source must have a Git commit');
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (strict && dirty) throw new Error('Commit all source changes before packaging');
  return dirty ? null : sha;
}

export async function loadSdkIdentity(root) {
  const name = '@waksana/cockpit-module-sdk';
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = metadata.devDependencies?.[name];
  const lock = parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const dependency = lock?.importers?.['.']?.devDependencies?.[name];
  const resolution = lock?.packages?.[`${name}@${version}`]?.resolution;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
    || lock?.lockfileVersion !== '9.0' || dependency?.specifier !== version
    || dependency?.version?.split('(')[0] !== version
    || typeof resolution?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(resolution.integrity)
    || typeof resolution?.tarball !== 'string'
    || !resolution.tarball.startsWith(`https://npm.pkg.github.com/download/${name}/${version}/`)) {
    throw new Error('SDK must be exactly pinned to a GitHub Packages resolution with SHA-512 integrity');
  }
  const url = new URL(resolution.tarball);
  if (url.username || url.password || url.search || url.hash) throw new Error('SDK resolution must not contain credentials or URL parameters');
  return { name, version, resolved: resolution.tarball, integrity: resolution.integrity };
}

export async function inventory(root, roots) {
  const files = [];
  async function visit(name) {
    if (!name || name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(name)) {
      throw new Error('Invalid inventory path');
    }
    const path = join(root, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(`${name}/${child}`);
    } else if (stat.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error(`Inventory contains a link or special file: ${name}`);
  }
  for (const name of roots) await visit(name);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function sdkIdentity(root) {
  const identity = await loadSdkIdentity(root);
  const installed = JSON.parse(await readFile(join(root, 'node_modules', identity.name, 'package.json'), 'utf8'));
  if (installed.name !== identity.name || installed.version !== identity.version) {
    throw new Error('Installed SDK differs from the locked package identity; run a frozen-lockfile install');
  }
  return identity;
}

export async function writeBuildReceipt(root, before) {
  const sourceSha = sourceIdentity(root);
  if (sourceSha !== before) throw new Error('Source identity changed during the build');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const expectedNode = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  if (process.versions.node !== expectedNode) throw new Error(`Build requires Node ${expectedNode}`);
  const receipt = {
    format: 2, product: 'cockpit-speech', version: metadata.version, sourceSha,
    sdk: await sdkIdentity(root), node: process.versions.node, platform: process.platform, arch: process.arch,
    files: await inventory(root, ['cockpit.module.json', 'dist', 'LICENSE']),
  };
  const file = join(root, '.module-build.json');
  await rm(file, { force: true });
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

export async function checkedBuild(root) {
  const sourceSha = sourceIdentity(root, true);
  const file = join(root, '.module-build.json');
  if (!(await lstat(file)).isFile()) throw new Error('Build receipt must be a regular file');
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  const sdk = await sdkIdentity(root);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (receipt.format !== 2 || receipt.product !== 'cockpit-speech' || receipt.sourceSha !== sourceSha
    || receipt.version !== metadata.version || receipt.node !== process.versions.node
    || receipt.platform !== process.platform || receipt.arch !== process.arch || !sameJson(receipt.sdk, sdk)
    || !sameJson(receipt.files, await inventory(root, ['cockpit.module.json', 'dist', 'LICENSE']))) {
    throw new Error('Build output is stale or modified; rebuild the clean committed source');
  }
  return receipt;
}
