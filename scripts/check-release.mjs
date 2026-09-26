import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './verify-package.mjs';
import { rollingTag } from './rolling-identity.mjs';

export function checkTagTarget(tag, sha, refs) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-rolling\.[1-9]\d*)?$/);
  const targets = new Map(refs.trim().split('\n').filter(Boolean).map(line => {
    const [target, ref, extra] = line.trim().split(/\s+/);
    assert.match(target, /^[a-f0-9]{40}$/);
    assert.ok(!extra && [ `refs/tags/${tag}`, `refs/tags/${tag}^{}` ].includes(ref));
    return [ref, target];
  }));
  assert.ok(targets.has(`refs/tags/${tag}`), 'Version tag is missing');
  assert.equal(targets.get(`refs/tags/${tag}^{}`) ?? targets.get(`refs/tags/${tag}`), sha, 'Version tag moved');
}

export async function checkRelease(root, tag, sha, directory) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-rolling\.[1-9]\d*)?$/, 'Invalid release tag');
  assert.match(sha, /^[a-f0-9]{40}$/, 'Release source must be an exact commit');
  const version = tag.slice(1);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  const rolling = rollingTag.test(tag);
  assert.ok(metadata.version === version || (rolling && metadata.version === '0.0.0-dev'), 'Tag and package version differ');
  assert.ok(manifest.version === version || (rolling && manifest.version === '0.0.0-dev'), 'Tag and module version differ');
  const notes = await readFile(join(root, 'docs/release-notes.md'), 'utf8');
  if (!rolling) assert.match(notes.split(/\r?\n/)[0], new RegExp(`^# Cockpit Speech ${version}(?: |$)`));
  const archive = `cockpit-speech-${version}.tgz`;
  assert.deepEqual((await readdir(directory)).sort(), [archive, `${archive}.sha256`,
    ...(rolling ? ['cockpit-deployment.json', 'cockpit-deployment.json.sha256'] : [])].sort());
  const result = await verifyPackage(root, join(directory, archive), sha, rolling ? version : undefined);
  const host = JSON.parse(await readFile(join(root, 'tooling/host-compatibility.json'), 'utf8'));
  assert.equal(host.repository, 'waksana/cockpit');
  assert.match(host.commit, /^[a-f0-9]{40}$/);
  return { ...result, host };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, sha, directory, ...extra] = process.argv.slice(2);
  if (!tag || !sha || !directory || extra.length) throw new Error('Usage: check-release.mjs TAG SOURCE_SHA ARTIFACT_DIRECTORY');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await checkRelease(root, tag, sha, resolve(directory));
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root, stdio: 'pipe' });
  const refs = execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
  checkTagTarget(tag, sha, refs);
  console.log(JSON.stringify(result));
}
