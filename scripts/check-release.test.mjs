import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRelease, checkTagTarget } from './check-release.mjs';
import { releaseFixture, commitFixture } from './test-support/release-fixture.mjs';
import { sourceIdentity } from './build-identity.mjs';
import { packageModule } from './package.mjs';

test('Rolling workflow builds every exact merged PR independently and preserves the verified archive', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const text of ['types: [closed]', 'github.event.pull_request.merged == true', 'actions: read',
    'ref: ${{ github.event.pull_request.merge_commit_sha }}', 'node scripts/rolling.mjs publish',
    'name: rolling-${{ github.run_number }}']) {
    assert.ok(workflow.includes(text), text);
  }
  assert.ok(workflow.indexOf('rolling.mjs verify') < workflow.indexOf('rolling.mjs publish'));
  assert.doesNotMatch(workflow, /releases\/tags|gh release (?:edit|download|create)/);
  assert.doesNotMatch(workflow, /--clobber|secrets\.|^\s*(?:concurrency|paths|paths-ignore|tags|labels):/m);
  for (const [, use] of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
    if (!use.startsWith('./')) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
  }
});

test('remote tag must still resolve to the checked source', () => {
  const sha = 'a'.repeat(40);
  checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${sha}\trefs/tags/v0.1.0^{}`);
  assert.throws(() => checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0`), /moved/);
});

test('downloaded release verification binds version, source, manifest and checksum', async t => {
  const f = await releaseFixture(t);
  await mkdir(join(f.root, 'tooling'));
  await writeFile(join(f.root, 'tooling/host-compatibility.json'),
    JSON.stringify({ repository: 'waksana/cockpit', commit: 'b'.repeat(40) }));
  await writeFile(join(f.root, 'docs/release-notes.md'), '# Cockpit Speech 0.1.0\n');
  commitFixture(f.root);
  await f.receipt();
  const sha = sourceIdentity(f.root);
  const archive = await packageModule(f.root, f.output);
  assert.equal((await checkRelease(f.root, 'v0.1.0', sha, f.output)).sourceSha, sha);
  await assert.rejects(checkRelease(f.root, 'v0.2.0', sha, f.output), /Tag and package version/);
  await assert.rejects(checkRelease(f.root, 'v0.1.0', 'a'.repeat(40), f.output));
  const manifest = JSON.parse(await readFile(join(f.root, 'cockpit.module.json'), 'utf8'));
  await writeFile(join(f.root, 'cockpit.module.json'), JSON.stringify({ ...manifest, backend: 'dist/changed.js' }));
  await assert.rejects(checkRelease(f.root, 'v0.1.0', sha, f.output), /Archive manifest differs/);
  await writeFile(join(f.root, 'cockpit.module.json'), JSON.stringify(manifest));
  await writeFile(`${archive}.sha256`, 'Invalid checksum');
  await assert.rejects(checkRelease(f.root, 'v0.1.0', sha, f.output));
});
