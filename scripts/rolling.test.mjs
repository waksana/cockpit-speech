import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { identity, mergeIdentity, prepareRolling, rollingSource, displayVersion, repository } from './rolling-identity.mjs';
import { moduleProduct } from './deployment-manifest.mjs';
import { checkRemoteTag, releaseNotes } from './rolling.mjs';
import { releaseFixture, commitFixture } from './test-support/release-fixture.mjs';
import { writeBuildReceipt, sourceIdentity } from './build-identity.mjs';
import { packageModule } from './package.mjs';
import { checkRelease } from './check-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = 'a'.repeat(40);
const event = (number, title = 'docs: complete title') => ({ action: 'closed', repository: { full_name: repository },
  pull_request: { number, title, body: 'Complete\n\nmultiline body\nwith all details', merged: true,
    base: { ref: 'main', repo: { full_name: repository } }, merge_commit_sha: number.toString(16).padStart(40, '0') } });

test('consecutive docs/chore/feature merges get exact immutable sequence identity; rerun keeps it', () => {
  const events = ['docs: one', 'chore: two', 'feat: three'].map((title, index) => event(index + 1, title));
  const attempts = events.map((value, index) => mergeIdentity(value, index + 91));
  assert.equal(new Set(attempts.map(value => value.tag)).size, 3);
  assert.deepEqual(attempts.map(value => value.sourceSha), events.map(value => value.pull_request.merge_commit_sha));
  assert.deepEqual(mergeIdentity(events[0], 91), attempts[0]);
  assert.throws(() => mergeIdentity({ ...event(1), pull_request: { ...event(1).pull_request, merged: false } }, 94));
  for (const invalid of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => identity(sha, invalid));
});

test('out-of-order completion and a failed attempt cannot regress increasing sequence selection', () => {
  const candidates = [identity(sha, 93), identity(sha, 91), identity(sha, 94)];
  // Consumer contract: failure at 92 yields no candidate; completion order is not freshness.
  let selected = 0;
  const selectedAfterCompletion = candidates.map(candidate => selected = Math.max(selected, candidate.sequence));
  assert.deepEqual(selectedAfterCompletion, [93, 93, 94]);
});

test('workflow trigger covers all merges without cancellation, filters, mutable identity or main writes', async () => {
  const text = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const workflow = parse(text);
  assert.deepEqual(workflow.on, { pull_request_target: { branches: ['main'], types: ['closed'] } });
  assert.equal(workflow.name, 'Rolling');
  assert.equal(workflow.concurrency, undefined);
  assert.equal(workflow.jobs.build.if, 'github.event.pull_request.merged == true');
  assert.deepEqual(Object.keys(workflow.jobs), ['build', 'publish']);
  assert.equal(workflow.jobs.publish.needs, 'build');
  assert.doesNotMatch(text, /git push|run_attempt|workflow_run|cancel-in-progress:\s*true|--clobber|overwrite:/);
  const promotion = await readFile(new URL('../.github/workflows/milestone.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(promotion, /pnpm (?:build|package)|rolling\.mjs prepare|release create|git push/);
  assert.match(promotion, /confirmation/);
});

test('main stays dev and build display does not change independent SDK identity', async () => {
  for (const name of ['package.json', 'cockpit.module.json']) {
    assert.equal(JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8')).version, '0.0.0-dev');
  }
  assert.equal(displayVersion('0.0.0-dev', sha), 'dev+aaaaaaaa');
  assert.equal(displayVersion('0.0.0-rolling.99', sha), '0.0.0-rolling.99');
  const product = await moduleProduct(root);
  assert.deepEqual(product, {
    kind: 'module', id: 'cockpit-speech', hostApi: { min: 1, max: 1 },
    requiresCapabilities: ['chatWindow.v1', 'composerInput.v1', 'draftLifecycle.v1', 'draftSubmission.v1',
      'frontend-api.v2', 'module-api.v1', 'ui.v1', 'uiSurface.v1'],
    requiredIntents: [], databases: [], migrations: [],
  });
});

test('Rolling package binds four assets, standalone checksums and byte-identical source-derived descriptor', async t => {
  const f = await releaseFixture(t);
  for (const name of ['package.json', 'cockpit.module.json']) {
    const value = JSON.parse(await readFile(join(f.root, name)));
    await writeFile(join(f.root, name), JSON.stringify({ ...value, version: '0.0.0-dev' }));
  }
  await writeFile(join(f.root, '.gitignore'), 'node_modules/\ndist/\n.module-build.json\n.rolling-build.json\ncockpit-deployment.json\noutput/\n');
  for (const directory of ['src/web', 'src/server', 'tooling']) await mkdir(join(f.root, directory), { recursive: true });
  for (const name of ['src/web/index.ts', 'src/server/index.ts', 'src/server/config.ts', 'tooling/host-compatibility.json']) {
    await writeFile(join(f.root, name), await readFile(new URL(`../${name}`, import.meta.url)));
  }
  commitFixture(f.root);
  const sourceSha = sourceIdentity(f.root);
  const value = await prepareRolling(f.root, sourceSha, 91);
  assert.deepEqual(rollingSource(f.root), value);
  await mkdir(join(f.root, 'dist/shared'), { recursive: true });
  await writeFile(join(f.root, 'dist/shared/version.js'), `export const version = ${JSON.stringify(value.version)};\n`);
  await writeBuildReceipt(f.root, sourceSha);
  const archive = await packageModule(f.root, f.output);
  assert.equal((await checkRelease(f.root, value.tag, sourceSha, f.output)).version, value.version);
  const descriptor = await readFile(join(f.output, 'cockpit-deployment.json'));
  assert.deepEqual(execFileSync('tar', ['-xOzf', archive, 'cockpit-deployment.json']), descriptor);
  assert.equal(JSON.parse(descriptor).archive.sha256, undefined);
  const notes = await releaseNotes(event(1), value, f.output);
  assert.ok(notes.includes(event(1).pull_request.body));
  assert.ok(notes.includes(event(1).pull_request.title));
  await writeFile(join(f.output, 'cockpit-deployment.json'), Buffer.concat([descriptor, Buffer.from(' ')]));
  await assert.rejects(checkRelease(f.root, value.tag, sourceSha, f.output), /sidecar bytes/);
  await writeFile(join(f.root, 'private-fixture.txt'), 'Unexpected source mutation');
  assert.throws(() => rollingSource(f.root), /Unexpected edits/);
});

test('immutable tag creation uses one write; unknown writes and moved tags stop without retry', () => {
  const value = identity(sha, 91);
  const writes = [];
  let exists = false;
  const run = args => {
    if (args.includes('POST')) { writes.push(args); exists = true; return Buffer.from('{}'); }
    return Buffer.from(JSON.stringify(exists ? [{ ref: `refs/tags/${value.tag}`, object: { type: 'commit', sha } }] : []));
  };
  checkRemoteTag(run, value.tag, sha, true);
  checkRemoteTag(run, value.tag, sha, true);
  assert.equal(writes.length, 1);
  assert.throws(() => checkRemoteTag(run, value.tag, 'b'.repeat(40), true), /changed/);
  let attempts = 0;
  assert.throws(() => checkRemoteTag(args => {
    if (args.includes('POST')) { attempts++; throw new Error('lost response'); }
    return Buffer.from('[]');
  }, value.tag, sha, true), /unknown result/);
  assert.equal(attempts, 1);
});
