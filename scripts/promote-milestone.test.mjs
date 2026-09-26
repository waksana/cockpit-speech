import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promoteMilestone } from './promote-milestone.mjs';
import { identity, repository } from './rolling-identity.mjs';
import { publicationNotes } from './release-assets.mjs';

function fixture(options = {}) {
  const value = identity('a'.repeat(40), 91);
  const archive = `cockpit-speech-${value.version}.tgz`;
  const content = new Map([archive, `${archive}.sha256`, 'cockpit-deployment.json', 'cockpit-deployment.json.sha256']
    .map(name => [name, Buffer.from(`Synthetic ${name}`)]));
  const release = { id: 42, tag_name: value.tag, target_commitish: value.sourceSha,
    name: `Cockpit Speech ${value.tag}`, body: 'Original\nfull\nPR body', draft: false, prerelease: true,
    created_at: '2026-09-26T00:00:00Z', published_at: '2026-09-26T00:00:01Z' };
  const assets = [...content].map(([name, bytes], index) => ({ id: 11 + index, name, size: bytes.length,
    state: 'uploaded', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }));
  release.body = publicationNotes(`${release.body}\n${content.get(`${archive}.sha256`)}\n${content.get('cockpit-deployment.json.sha256')}\n`,
    release.id, value.tag, value.sourceSha, assets);
  const calls = [];
  let assetReads = 0;
  const endpoint = `repos/${repository}/releases`;
  const run = args => {
    calls.push(args);
    const response = value => Buffer.from(JSON.stringify(value));
    if (args.includes('PATCH')) {
      assert.deepEqual(args, ['api', `${endpoint}/42`, '--method', 'PATCH',
        '-F', 'prerelease=false', '-f', 'make_latest=true']);
      release.prerelease = false;
      if (options.unknown) throw new Error('Synthetic lost response');
      if (options.afterChange) release.body += 'changed';
      return response(release);
    }
    if (args[1].includes('/git/matching-refs/')) return response([{
      ref: `refs/tags/${value.tag}`, object: { type: 'commit', sha: value.sourceSha },
    }]);
    if (args[1] === `${endpoint}?per_page=100`) return response([[release]]);
    if (args[1] === `${endpoint}/42` || args[1] === `${endpoint}/latest`) return response(release);
    if (args[1] === `${endpoint}/42/assets?per_page=100`) {
      assetReads++;
      if (options.race && assetReads === 2) assets[0].id = 99;
      return response([assets]);
    }
    const asset = assets.find(asset => args[1] === `${endpoint}/assets/${asset.id}`);
    assert.ok(asset, `Unexpected request ${args}`);
    asset.download_count = (asset.download_count ?? 0) + 1;
    return content.get(asset.name);
  };
  const verify = async (tag, sha, directory) => {
    assert.equal(tag, value.tag);
    assert.equal(sha, value.sourceSha);
    if (options.verifyError) throw new Error('Descriptor/checksum/archive mismatch');
    for (const [name, bytes] of content) assert.deepEqual(await readFile(join(directory, name)), bytes);
  };
  return { release, assets, content, calls, value,
    promote: (tag = value.tag, confirmation = tag) => promoteMilestone({ tag, confirmation, sha: value.sourceSha }, { run, verify }),
    mutations: () => calls.filter(args => args.includes('PATCH') || args.includes('POST')),
  };
}

test('Milestone changes only prerelease and Latest on original ID, with all identities and bytes unchanged', async () => {
  const f = fixture();
  const before = structuredClone(f.release);
  assert.equal((await f.promote()).status, 'milestone');
  assert.deepEqual(f.release, { ...before, prerelease: false });
  assert.equal(f.mutations().length, 1);
  await assert.rejects(f.promote(), /unpromoted/);
  assert.equal(f.mutations().length, 1);
});

test('Milestone rejects non-Rolling, unconfirmed, draft, incomplete and changed assets before writes', async () => {
  for (const kind of ['tag', 'confirm', 'draft', 'missing', 'bytes', 'digest', 'race', 'verifyError', 'replaced', 'notes']) {
    const f = fixture({ [kind]: true });
    if (kind === 'draft') f.release.draft = true;
    if (kind === 'missing') f.assets.pop();
    if (kind === 'bytes') f.content.set(f.assets[0].name, Buffer.alloc(f.assets[0].size));
    if (kind === 'digest') f.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    if (kind === 'replaced') {
      const bytes = Buffer.from('Internally consistent replacement archive');
      f.content.set(f.assets[0].name, bytes);
      Object.assign(f.assets[0], { id: 99, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    }
    if (kind === 'notes') f.release.body = f.release.body.replace('Synthetic cockpit-deployment.json.sha256', 'changed-checksum');
    await assert.rejects(f.promote(kind === 'tag' ? 'v0.9.3' : undefined, kind === 'confirm' ? 'wrong' : undefined));
    assert.equal(f.mutations().length, 0);
  }
});

test('unknown promotion and post-write identity drift stop with no retry or replacement', async () => {
  for (const option of ['unknown', 'afterChange']) {
    const f = fixture({ [option]: true });
    await assert.rejects(f.promote(), /unknown result|changed immutable identity/);
    assert.equal(f.mutations().length, 1);
  }
});
