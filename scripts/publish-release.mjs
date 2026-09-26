import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runGh = args => execFileSync('gh', args, { maxBuffer: 34 * 1024 * 1024, timeout: 120_000 });
const verifyArtifact = (tag, sha, directory) => execFileSync(process.execPath,
  [join(root, 'scripts/check-release.mjs'), tag, sha, directory],
  { cwd: root, stdio: 'pipe', timeout: 120_000 });

export async function publishRelease({ repository, tag, sha, directory }, { run = runGh, verify = verifyArtifact } = {}) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const archive = `cockpit-speech-${tag.slice(1)}.tgz`;
  const names = [archive, `${archive}.sha256`].sort();
  const endpoint = `repos/${repository}/releases`;
  const json = args => JSON.parse(run(['api', ...args]).toString());
  const pages = path => {
    const result = json([`${path}?per_page=100`, '--paginate', '--slurp']);
    assert.ok(Array.isArray(result) && result.length > 0 && result.every(Array.isArray), 'Invalid paginated response');
    return result.flat();
  };
  const discover = () => {
    const releases = pages(endpoint);
    assert.ok(releases.every(release => release && typeof release.tag_name === 'string'
      && Number.isSafeInteger(release.id) && release.id > 0 && typeof release.draft === 'boolean'),
    'Invalid Release discovery response');
    const matches = releases.filter(release => release.tag_name === tag);
    assert.ok(matches.length <= 1, `Conflicting Releases for exact tag ${tag}; inspect all matching IDs`);
    return matches[0];
  };
  const mutate = args => {
    try {
      return run(args);
    } catch (cause) {
      throw new Error(`Release mutation (${args[0]} ${args[1]}) failed or has an unknown result for ${tag}. Stop and inspect Releases and assets by ID before any explicit rerun; no mutation was retried.`, { cause });
    }
  };
  const releaseAt = (id, draft) => {
    const release = json([`${endpoint}/${id}`]);
    assert.equal(release.id, id, 'Release ID changed');
    assert.equal(release.tag_name, tag, 'Release tag changed');
    assert.equal(release.draft, draft, 'Unexpected draft/published state');
    assert.equal(release.prerelease, false, 'Prerelease is not a stable Release');
    return release;
  };
  const assetsAt = id => {
    const assets = pages(`${endpoint}/${id}/assets`);
    assert.deepEqual(assets.map(asset => asset.name).sort(), names, 'Incomplete or conflicting Release assets; never replace or upload into an existing draft');
    assert.equal(new Set(assets.map(asset => asset.id)).size, names.length, 'Duplicate asset IDs');
    for (const asset of assets) {
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset ID');
      assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 32 * 1024 * 1024, 'Invalid asset size');
      assert.equal(asset.state, 'uploaded', 'Asset upload is incomplete');
    }
    return assets.sort((a, b) => a.name.localeCompare(b.name));
  };
  const inspect = async (id, draft) => {
    releaseAt(id, draft);
    const assets = assetsAt(id);
    const downloaded = await mkdtemp(join(tmpdir(), 'cockpit-speech-release-'));
    try {
      for (const asset of assets) {
        const bytes = run(['api', `${endpoint}/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']);
        assert.equal(bytes.length, asset.size, 'Downloaded asset size differs');
        assert.deepEqual(bytes, await readFile(join(directory, asset.name)), 'Release asset bytes differ from the checked archive');
        await writeFile(join(downloaded, asset.name), bytes, { flag: 'wx' });
      }
      await verify(tag, sha, downloaded);
    } finally {
      await rm(downloaded, { recursive: true });
    }
    return assets;
  };

  await verify(tag, sha, directory);
  let release = discover();
  if (release) {
    assert.equal(release.draft, true, `Release ${tag} is already published; refusing to mutate it`);
  } else {
    const generated = json([`${endpoint}/generate-notes`, '--method', 'POST', '-f', `tag_name=${tag}`, '-f', `target_commitish=${sha}`]);
    assert.equal(typeof generated.body, 'string', 'Invalid generated release notes');
    const notes = await readFile(join(root, 'docs/release-notes.md'), 'utf8');
    // gh release create retries uploads internally. Keep every write a single API request.
    const created = JSON.parse(mutate(['api', endpoint, '--method', 'POST',
      '-f', `tag_name=${tag}`, '-f', `target_commitish=${sha}`, '-F', 'draft=true', '-F', 'prerelease=false',
      '-f', `name=Cockpit Speech ${tag}`, '-f', `body=${notes}\n\n${generated.body}`]).toString());
    assert.ok(Number.isSafeInteger(created.id) && created.id > 0, 'Create returned no Release ID; inspect the unknown result before rerunning');
    release = discover();
    assert.equal(release?.id, created.id, 'Created draft discovery differs; inspect the unknown result before rerunning');
    releaseAt(created.id, true);
    assert.deepEqual(pages(`${endpoint}/${created.id}/assets`), [], 'New draft already has assets; refusing to upload');
    for (const name of names) {
      mutate(['api', `https://uploads.github.com/${endpoint}/${created.id}/assets?name=${encodeURIComponent(name)}`,
        '--method', 'POST',
        '-H', 'Content-Type: application/octet-stream', '--input', join(directory, name)]);
    }
  }
  const id = release.id;
  const assets = await inspect(id, true);
  assert.equal(discover()?.id, id, 'Release discovery changed before publication');
  releaseAt(id, true);
  assert.deepEqual(assetsAt(id), assets, 'Release assets changed before publication');
  mutate(['api', `${endpoint}/${id}`, '--method', 'PATCH',
    '-F', 'draft=false', '-F', 'prerelease=false', '-f', 'make_latest=true']);
  assert.equal(discover()?.id, id, 'Published Release discovery changed; inspect before retrying');
  await inspect(id, false);
  return { id, tag, status: 'published' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, sha, directory, ...extra] = process.argv.slice(2);
  if (!tag || !sha || !directory || extra.length) throw new Error('Usage: publish-release.mjs TAG SOURCE_SHA ARTIFACT_DIRECTORY');
  console.log(JSON.stringify(await publishRelease({ repository: process.env.GITHUB_REPOSITORY, tag, sha, directory: resolve(directory) })));
}
