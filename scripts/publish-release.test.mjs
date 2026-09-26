import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { publishRelease } from './publish-release.mjs';

const tag = 'v0.9.3';
const sha = 'a'.repeat(40);
const repository = 'waksana/cockpit-speech';
const endpoint = `repos/${repository}/releases`;
const archive = 'cockpit-speech-0.9.3.tgz';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'speech-publish-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const bytes = new Map([[archive, Buffer.from('checked archive')], [`${archive}.sha256`, Buffer.from('checked checksum')]]);
  for (const [name, content] of bytes) await writeFile(join(directory, name), content);
  const state = {
    releases: [{ id: 42, tag_name: tag, draft: true, prerelease: false, target_commitish: 'main' }],
    assets: [...bytes].map(([name, content], i) => ({ id: 10 + i, name, size: content.length, state: 'uploaded' })),
    calls: [], verified: [], bytes: new Map(bytes),
    ...overrides,
  };
  const run = args => {
    state.calls.push(args);
    const response = value => Buffer.from(JSON.stringify(value));
    if (state.intercept) {
      const value = state.intercept(args, state);
      if (value !== undefined) return response(value);
    }
    assert.equal(args[0], 'api', 'Only single-request API calls, not retrying release commands');
    if (args[1] === `${endpoint}/generate-notes`) return response({ body: 'Generated notes' });
    if (args[1] === endpoint && args.includes('POST')) {
      assert.ok(args.includes(`tag_name=${tag}`) && args.includes(`target_commitish=${sha}`));
      assert.ok(args.includes('draft=true') && args.includes('prerelease=false'));
      state.releases.push({ id: 42, tag_name: tag, draft: true, prerelease: false, target_commitish: sha });
      state.assets = [];
      if (state.createError) throw new Error('Create acknowledgement lost');
      return response(state.releases[0]);
    }
    if (args[1].startsWith('https://uploads.github.com/')) {
      assert.ok(args.includes('POST') && args.includes('Content-Type: application/octet-stream'));
      const name = new URL(args[1]).searchParams.get('name');
      assert.equal(args[1], `https://uploads.github.com/${endpoint}/42/assets?name=${name}`);
      assert.equal(args[args.indexOf('--input') + 1], join(directory, name));
      state.assets.push({ id: 10 + state.assets.length, name, size: bytes.get(name).length, state: 'uploaded' });
      if (state.uploadError) throw new Error('Upload acknowledgement lost');
      return response(state.assets.at(-1));
    }
    assert.ok(!args[1].includes('/tags/'), 'Never use the published-tag endpoint');
    if (args.includes('PATCH')) {
      assert.equal(args[1], `${endpoint}/42`);
      assert.ok(args.includes('draft=false') && args.includes('prerelease=false') && args.includes('make_latest=true'));
      state.releases.find(release => release.id === 42).draft = false;
      if (state.publishError) throw new Error('Publish acknowledgement lost');
      return response(state.releases[0]);
    }
    if (args[1] === `${endpoint}?per_page=100`) {
      assert.deepEqual(args.slice(2), ['--paginate', '--slurp']);
      return response([[{ id: 7, tag_name: `${tag}0`, draft: true }], state.releases]);
    }
    if (args[1] === `${endpoint}/42`) return response(state.releases.find(release => release.id === 42));
    if (args[1] === `${endpoint}/42/assets?per_page=100`) {
      assert.deepEqual(args.slice(2), ['--paginate', '--slurp']);
      return response(state.assets.length ? state.assets.map(asset => [asset]) : [[]]);
    }
    const asset = state.assets.find(item => args[1] === `${endpoint}/assets/${item.id}`);
    assert.ok(asset, `Unexpected call: ${args}`);
    assert.deepEqual(args.slice(2), ['-H', 'Accept: application/octet-stream']);
    return state.bytes.get(asset.name);
  };
  const verify = async (actualTag, actualSha, path) => {
    assert.equal(actualTag, tag);
    assert.equal(actualSha, sha);
    state.verified.push(path);
    if (state.verifyErrorAt === state.verified.length) throw new Error('Tag/source/version identity mismatch');
    for (const [name, content] of bytes) assert.deepEqual(await readFile(join(path, name)), content);
  };
  return {
    state, directory,
    publish: () => publishRelease({ repository, tag, sha, directory }, { run, verify }),
    mutations: () => state.calls.filter(args => args.includes('PATCH')
      || (args.includes('POST') && !args[1].endsWith('/generate-notes'))),
  };
}

test('recovers the unique exact-tag complete draft across pages using only IDs', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.publish(), { id: 42, tag, status: 'published' });
  assert.equal(f.mutations().length, 1);
  assert.ok(f.mutations()[0].includes('PATCH'));
  assert.equal(f.state.verified.length, 3);
});

test('creates only after successful complete discovery proves absence', async t => {
  const f = await fixture(t, { releases: [] });
  await f.publish();
  assert.equal(f.mutations().length, 4);
  assert.equal(f.mutations()[0][1], endpoint);
  assert.ok(f.mutations().slice(1, 3).every(args => args[1].startsWith('https://uploads.github.com/')));
});

test('lookup errors and malformed pages do not establish absence', async t => {
  for (const result of [null, {}, [], [null], [[{ id: 42 }]]]) {
    const f = await fixture(t, { intercept: args => args[1] === `${endpoint}?per_page=100` ? result : undefined });
    await assert.rejects(f.publish(), /Invalid/);
    assert.equal(f.mutations().length, 0);
  }
  const f = await fixture(t, { intercept: () => { throw new Error('HTTP 403/404/429 or network failure'); } });
  await assert.rejects(f.publish(), /HTTP/);
  assert.equal(f.mutations().length, 0);
});

test('rejects published, prerelease and conflicting exact-tag Releases without writes', async t => {
  for (const variant of ['published', 'prerelease', 'duplicate', 'mixed']) {
    const f = await fixture(t);
    if (variant === 'published') f.state.releases[0].draft = false;
    if (variant === 'prerelease') f.state.releases[0].prerelease = true;
    if (variant === 'duplicate' || variant === 'mixed') {
      f.state.releases.push({ ...f.state.releases[0], id: 43, draft: variant === 'duplicate' });
    }
    await assert.rejects(f.publish(), /already published|Prerelease|Conflicting/);
    assert.equal(f.mutations().length, 0);
  }
});

test('refuses missing, extra, duplicate, incomplete, invalid-size and different-byte assets', async t => {
  for (const variant of ['missing', 'extra', 'duplicate-name', 'duplicate-id', 'incomplete', 'size', 'bytes']) {
    const f = await fixture(t);
    if (variant === 'missing') f.state.assets.pop();
    if (variant === 'extra') f.state.assets.push({ id: 12, name: 'other', size: 1, state: 'uploaded' });
    if (variant === 'duplicate-name') f.state.assets[1].name = archive;
    if (variant === 'duplicate-id') f.state.assets[1].id = f.state.assets[0].id;
    if (variant === 'incomplete') f.state.assets[0].state = 'new';
    if (variant === 'size') f.state.assets[0].size = 0;
    if (variant === 'bytes') f.state.bytes.set(archive, Buffer.from('altered archive'));
    await assert.rejects(f.publish(), /assets|IDs|upload|size|bytes/);
    assert.equal(f.mutations().length, 0);
  }
});

test('source/tag/version verification fails closed before creation or publication', async t => {
  for (const verifyErrorAt of [1, 2]) {
    const f = await fixture(t, { verifyErrorAt });
    await assert.rejects(f.publish(), /identity mismatch/);
    assert.equal(f.mutations().length, 0);
  }
});

test('rechecks ID, tag, uniqueness and asset identity before publishing', async t => {
  for (const variant of ['id', 'tag', 'duplicate', 'asset']) {
    let reads = 0;
    const f = await fixture(t, { intercept: (args, state) => {
      if (variant === 'duplicate' && args[1] === `${endpoint}?per_page=100` && ++reads === 2) {
        state.releases.push({ ...state.releases[0], id: 43 });
      }
      if (variant === 'asset' && args[1] === `${endpoint}/42/assets?per_page=100` && ++reads === 2) {
        state.assets[0].id = 99;
      }
      if (['id', 'tag'].includes(variant) && args[1] === `${endpoint}/42` && ++reads === 2) {
        return { ...state.releases[0], [variant === 'id' ? 'id' : 'tag_name']: variant === 'id' ? 99 : 'v9.9.9' };
      }
    } });
    await assert.rejects(f.publish(), /changed|Conflicting/);
    assert.equal(f.mutations().length, 0);
  }
});

test('uncertain create, upload and publish stop immediately without retry or repair', async t => {
  for (const variant of ['create', 'upload', 'publish']) {
    const f = await fixture(t, variant === 'publish' ? { publishError: true } : { releases: [], [`${variant}Error`]: true });
    await assert.rejects(f.publish(), /unknown result.*no mutation was retried/);
    assert.equal(f.mutations().length, variant === 'upload' ? 2 : 1);
    assert.equal(f.state.calls.at(-1), f.mutations().at(-1));
  }
});

test('failed final readback or verification never retries successful publication', async t => {
  for (const variant of ['readback', 'verify']) {
    const f = await fixture(t, {
      verifyErrorAt: variant === 'verify' ? 3 : undefined,
      intercept: (args, state) => {
        if (variant === 'readback' && args[1] === `${endpoint}/42` && !state.releases[0].draft) {
          throw new Error('Final readback unavailable');
        }
      },
    });

    await assert.rejects(f.publish(), /readback unavailable|identity mismatch/);
    assert.equal(f.mutations().length, 1);
    assert.equal(f.state.releases[0].draft, false);
  }
});

test('gh api sends each failed write only once at the HTTP boundary', async t => {
  const f = await fixture(t);
  let requests = 0;
  let failure = 'http';
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    request.on('end', () => {
      if (failure === 'network') request.socket.destroy();
      else response.writeHead(500).end('Synthetic server failure after receiving the write');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const endpoint = `http://127.0.0.1:${server.address().port}/release`;
  const execute = promisify(execFile);
  for (failure of ['http', 'network']) {
    for (const args of [
      ['--method', 'POST', '-F', 'draft=true'],
      ['--method', 'POST', '-H', 'Content-Type: application/octet-stream', '--input', join(f.directory, archive)],
      ['--method', 'PATCH', '-F', 'draft=false'],
    ]) {
      const before = requests;
      await assert.rejects(execute('gh', ['api', endpoint, ...args], {
        env: { ...process.env, GH_TOKEN: 'synthetic-test-token', GH_PROMPT_DISABLED: '1' }, timeout: 15_000,
      }));
      assert.equal(requests - before, 1, 'A failed write must not be retried internally');
    }
  }
});
