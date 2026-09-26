import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { checkTagTarget } from './check-release.mjs';

test('release workflow preserves the verified archive behind a draft gate', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const text of ['uses: ./.github/workflows/build.yml', 'actions: read', 'check-release.mjs',
    '--verify-tag --draft', 'gh release download', 'gh release edit "$RELEASE_TAG" --draft=false --prerelease=false --latest']) {
    assert.ok(workflow.includes(text), text);
  }
  assert.ok(workflow.indexOf('gh release download') < workflow.indexOf('gh release edit'));
  assert.doesNotMatch(workflow, /--clobber|pnpm (?:build|package)|pull_request_target|secrets\./);
  for (const [, use] of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
    if (!use.startsWith('./')) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
  }
});

test('remote tag must still resolve to the checked source', () => {
  const sha = 'a'.repeat(40);
  checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${sha}\trefs/tags/v0.1.0^{}`);
  assert.throws(() => checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0`), /moved/);
});
