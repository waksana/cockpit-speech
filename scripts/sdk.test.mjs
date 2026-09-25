import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { loadSdkIdentity, sdkIdentity } from './build-identity.mjs';
import { releaseFixture } from './test-support/release-fixture.mjs';

test('SDK receipt identifies the locked registry package without a host checkout', async t => {
  const f = await releaseFixture(t);
  assert.deepEqual(await loadSdkIdentity(f.root), f.sdk);
  assert.deepEqual(await sdkIdentity(f.root), f.sdk);
  await writeFile(join(f.root, 'node_modules', f.sdk.name, 'package.json'), JSON.stringify({ name: f.sdk.name, version: '0.1.1' }));
  await assert.rejects(sdkIdentity(f.root), /Installed SDK differs/);
});

test('SDK identity rejects ranges, local fallback, drift, missing integrity and credential-bearing URLs', async t => {
  const f = await releaseFixture(t);
  for (const mutate of [
    lock => { lock.importers['.'].devDependencies[f.sdk.name].specifier = '^0.2.0'; },
    lock => { lock.importers['.'].devDependencies[f.sdk.name].version = '0.1.1'; },
    lock => { delete lock.packages[`${f.sdk.name}@${f.sdk.version}`].resolution.integrity; },
    lock => { lock.packages[`${f.sdk.name}@${f.sdk.version}`].resolution.tarball = 'file:sdk.tgz'; },
    lock => { lock.packages[`${f.sdk.name}@${f.sdk.version}`].resolution.tarball = f.sdk.resolved + '?token=fixture'; },
  ]) {
    const lock = structuredClone(f.lock);
    mutate(lock);
    await writeFile(join(f.root, 'pnpm-lock.yaml'), stringify(lock));
    await assert.rejects(loadSdkIdentity(f.root), /SDK/);
  }
  await writeFile(join(f.root, 'pnpm-lock.yaml'), stringify(f.lock));
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ devDependencies: { [f.sdk.name]: '^0.2.0' } }));
  await assert.rejects(loadSdkIdentity(f.root), /SDK must be exactly pinned/);
});

test('CI uses authenticated registry installation and exact package verification without host source or deployment', async () => {
  const ci = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  for (const text of ['pull_request:', 'name: Required checks', 'packages: read',
    'SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
    'ref: ${{ env.SOURCE_SHA }}', '"$SOURCE_SHA"',
    'registry-url: https://npm.pkg.github.com', 'NODE_AUTH_TOKEN: ${{ github.token }}',
    'pnpm install --frozen-lockfile --ignore-scripts', 'pnpm typecheck', 'pnpm test',
    'pnpm build', 'pnpm package', 'verify-package.mjs']) assert.ok(ci.includes(text), text);
  assert.doesNotMatch(ci, /contents: write|packages: write|pull_request_target|secrets\.|ssh |systemctl|release create|sdk:prepare|host-sdk|legacy-peer-deps/);
  for (const [, use] of ci.matchAll(/uses:\s+([^\s]+)/g)) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
  assert.doesNotMatch(await readFile(new URL('../.npmrc', import.meta.url), 'utf8'), /authToken/);
  const tsconfig = JSON.parse(await readFile(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  assert.notEqual(tsconfig.compilerOptions.skipLibCheck, true);
});

test('published SDK has four importable public entries and no bundled runtime dependencies', async () => {
  const sdk = JSON.parse(await readFile(new URL('../node_modules/@waksana/cockpit-module-sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(sdk.version, '0.2.0');
  assert.deepEqual(Object.keys(sdk.exports).sort(), ['.', './backend', './frontend', './runtime']);
  assert.equal(Object.keys(sdk.dependencies ?? {}).length, 0);
  for (const name of ['@types/node', '@types/react', 'react']) assert.equal(sdk.peerDependenciesMeta[name].optional, true);
  for (const suffix of ['', '/backend', '/frontend', '/runtime']) await import(`@waksana/cockpit-module-sdk${suffix}`);
});

test('source icon nodes and shipped notice match lucide-static exactly', async () => {
  const metadata = JSON.parse(await readFile(new URL('../node_modules/lucide-static/package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.version, '1.46.0');
  const icons = await readFile(new URL('../src/web/icons.ts', import.meta.url), 'utf8');
  for (const name of ['mic', 'rotate-ccw']) {
    const svg = await readFile(new URL(`../node_modules/lucide-static/icons/${name}.svg`, import.meta.url), 'utf8');
    for (const [, path] of svg.matchAll(/d="([^"]+)"/g)) assert.ok(icons.includes(path));
  }
  assert.equal(
    await readFile(new URL('../licenses/lucide.txt', import.meta.url), 'utf8'),
    await readFile(new URL('../node_modules/lucide-static/LICENSE', import.meta.url), 'utf8'),
  );
});
