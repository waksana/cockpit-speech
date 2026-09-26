import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const repository = 'waksana/cockpit-speech';
export const rollingTag = /^v0\.0\.0-rolling\.([1-9]\d*)$/;
export function identity(sha, sequence) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0, 'Invalid Rolling sequence');
  const version = `0.0.0-rolling.${sequence}`;
  return { repository, sourceSha: sha, sequence, version, tag: `v${version}` };
}
export function mergeIdentity(event, sequence) {
  assert.equal(event.action, 'closed');
  assert.equal(event.repository?.full_name, repository);
  assert.equal(event.pull_request?.merged, true, 'Only actual merged PRs release');
  assert.equal(event.pull_request.base?.ref, 'main');
  assert.equal(event.pull_request.base?.repo?.full_name, repository);
  assert.ok(Number.isSafeInteger(event.pull_request.number) && event.pull_request.number > 0);
  assert.equal(typeof event.pull_request.title, 'string');
  assert.ok(event.pull_request.body === null || typeof event.pull_request.body === 'string');
  return identity(event.pull_request.merge_commit_sha, sequence);
}
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const injected = (text, version) => JSON.stringify({ ...JSON.parse(text), version }, null, 2) + '\n';

// Only these deterministic version edits are allowed in an isolated Rolling checkout.
export function rollingSource(root) {
  const path = join(root, '.rolling-build.json');
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(value, identity(git(root, ['rev-parse', 'HEAD']), value.sequence));
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  assert.deepEqual(status.split('\n').map(line => line.trim()).sort(),
    ['M cockpit.module.json', 'M package.json'], 'Unexpected edits in isolated Rolling source');
  for (const name of ['package.json', 'cockpit.module.json']) {
    const original = git(root, ['show', `HEAD:${name}`]);
    assert.equal(JSON.parse(original).version, '0.0.0-dev', 'Main must remain development source');
    assert.equal(readFileSync(join(root, name), 'utf8'), injected(original, value.version));
  }
  return value;
}
export async function prepareRolling(root, sha, sequence) {
  const value = identity(sha, sequence);
  assert.equal(git(root, ['rev-parse', 'HEAD']), sha, 'Checkout must be the exact merge SHA');
  assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Use a clean isolated checkout');
  assert.ok(!existsSync(join(root, '.rolling-build.json')), 'Never reuse an injected checkout');
  for (const name of ['package.json', 'cockpit.module.json']) {
    assert.equal(JSON.parse(await readFile(join(root, name), 'utf8')).version, '0.0.0-dev');
  }
  await writeFile(join(root, '.rolling-build.json'), JSON.stringify(value) + '\n', { flag: 'wx' });
  for (const name of ['package.json', 'cockpit.module.json']) {
    await writeFile(join(root, name), injected(await readFile(join(root, name), 'utf8'), value.version));
  }
  rollingSource(root);
  return value;
}
export const displayVersion = (version, sha) => version === '0.0.0-dev' ? `dev+${sha.slice(0, 8)}` : version;
