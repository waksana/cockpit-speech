import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repository, rollingTag, identity } from './rolling-identity.mjs';
import { checkRemoteTag, mutation, runGh } from './rolling.mjs';
import { checkRelease } from './check-release.mjs';
import { assetIdentity, publicationIdentity } from './release-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function promoteMilestone({ tag, confirmation, sha },
  { run = runGh, verify = (tag, sha, dir) => checkRelease(root, tag, sha, dir) } = {}) {
  assert.match(tag, rollingTag, 'Only existing Rolling releases may be promoted');
  assert.equal(confirmation, tag, 'Confirmation must repeat the exact Rolling tag');
  const value = identity(sha, Number(rollingTag.exec(tag)[1]));
  const endpoint = `repos/${repository}/releases`;
  const json = args => JSON.parse(run(['api', ...args]));
  const pages = path => {
    const result = json([`${path}?per_page=100`, '--paginate', '--slurp']);
    assert.ok(Array.isArray(result) && result.length > 0 && result.every(Array.isArray), 'Invalid discovery');
    return result.flat();
  };
  const discover = () => {
    const matches = pages(endpoint).filter(release => release.tag_name === tag);
    assert.equal(matches.length, 1, 'Expected exactly one existing Rolling Release');
    return matches[0];
  };
  const selected = discover();
  assert.ok(Number.isSafeInteger(selected.id) && selected.id > 0);
  const id = selected.id;
  assert.equal(selected.draft, false, 'Drafts cannot be promoted');
  assert.equal(selected.prerelease, true, 'Only unpromoted Rolling releases may be selected');
  assert.equal(selected.name, `Cockpit Speech ${tag}`);
  const original = publicationIdentity(selected.body);
  assert.equal(original.releaseId, id, 'Original Release ID changed');
  assert.equal(original.tag, tag, 'Original tag changed');
  assert.equal(original.sourceSha, sha, 'Original source changed');
  const names = [`cockpit-speech-${value.version}.tgz`, `cockpit-speech-${value.version}.tgz.sha256`,
    'cockpit-deployment.json', 'cockpit-deployment.json.sha256'].sort();
  async function inspect(prerelease) {
    checkRemoteTag(run, tag, sha);
    assert.equal(discover().id, id, 'Release discovery changed');
    const release = json([`${endpoint}/${id}`]);
    assert.equal(release.id, id);
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, sha);
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, prerelease);
    const assets = pages(`${endpoint}/${id}/assets`).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(assets.map(asset => asset.name).sort(), names, 'Incomplete or conflicting assets');
    assert.equal(new Set(assets.map(asset => asset.id)).size, 4);
    assert.deepEqual(assetIdentity(assets), original.assets, 'Assets differ from original publication identity');
    await mkdir(join(root, '.release-readback'), { recursive: true });
    const directory = await mkdtemp(join(root, '.release-readback', 'milestone-'));
    const bytes = [];
    try {
      for (const asset of assets) {
        assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
        assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 32 * 1024 * 1024);
        assert.equal(asset.state, 'uploaded');
        const content = run(['api', `${endpoint}/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']);
        assert.equal(content.length, asset.size);
        const digest = createHash('sha256').update(content).digest('hex');
        assert.equal(asset.digest, `sha256:${digest}`, 'Asset bytes differ from GitHub upload identity');
        bytes.push(digest);
        await writeFile(join(directory, asset.name), content, { flag: 'wx' });
      }
      await verify(tag, sha, directory);
      for (const name of [`cockpit-speech-${value.version}.tgz.sha256`, 'cockpit-deployment.json.sha256']) {
        const checksum = await readFile(join(directory, name), 'utf8');
        assert.ok(release.body.includes(checksum), 'Release notes differ from original published checksum');
      }
    } finally { await rm(directory, { recursive: true }); }
    return { id, tag, sha, name: release.name, body: release.body, created_at: release.created_at,
      published_at: release.published_at, assets: assetIdentity(assets), bytes };
  }
  const before = await inspect(true);
  assert.deepEqual(await inspect(true), before, 'Release identity changed before promotion');
  mutation(run, ['api', `${endpoint}/${id}`, '--method', 'PATCH', '-F', 'prerelease=false', '-f', 'make_latest=true']);
  assert.deepEqual(await inspect(false), before, 'Promotion changed immutable identity');
  assert.equal(json([`${endpoint}/latest`]).id, id, 'Latest does not identify the promoted release');
  return { id, tag, status: 'milestone', assets: before.assets.map(({ id, name, digest }) => ({ id, name, digest })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  console.log(JSON.stringify(await promoteMilestone({ tag: event.inputs.tag, confirmation: event.inputs.confirmation, sha })));
}
