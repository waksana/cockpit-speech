import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseConfig, readConfig } from './config.ts';

const config = { endpoint: 'https://synthetic-resource.cognitiveservices.azure.com/', key: 'synthetic-test-key-not-valid' };
test('config accepts only exact fields and a public Azure resource origin', () => {
  assert.deepEqual(parseConfig(config), { ...config, endpoint: config.endpoint.slice(0, -1) });
  for (const endpoint of ['http://x.cognitiveservices.azure.com', 'https://x.cognitiveservices.azure.com:443',
    'https://x.cognitiveservices.azure.com/path', 'https://x.cognitiveservices.azure.com?secret=1',
    'https://user@x.cognitiveservices.azure.com', 'https://x.cognitiveservices.azure.com.evil.invalid',
    'https://localhost', 'https://127.0.0.1', 'https://x.api.cognitive.microsoft.com',
    'https://-x.cognitiveservices.azure.com', 'https://x-.cognitiveservices.azure.com']) {
    assert.throws(() => parseConfig({ ...config, endpoint }), /endpoint must/);
  }
  for (const invalid of [{}, null, [], { ...config, other: true }, { ...config, key: '' },
    { ...config, key: 'a\nb' }, { ...config, key: 'secret ' }, { endpoint: 1, key: 'test' }]) {
    assert.throws(() => parseConfig(invalid));
  }
});
test('config is reread, bounded, non-symlink and never exposes its bytes on errors', async () => {
  const root = resolve('.test-work', randomUUID());
  await mkdir(root, { recursive: true });
  const path = join(root, 'azure-speech.json');
  try {
    await assert.rejects(readConfig(root), /azure-speech.json.*endpoint and key/);
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    assert.equal((await readConfig(root)).key, config.key);
    await writeFile(path, JSON.stringify({ ...config, key: 'updated-synthetic-test-key' }));
    assert.equal((await readConfig(root)).key, 'updated-synthetic-test-key');
    for (const bytes of ['{"key":"private-marker",', 'x'.repeat(16 * 1024 + 1)]) {
      await writeFile(path, bytes);
      await assert.rejects(readConfig(root), error => {
        assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private-marker|xxxxxxxx/); return true;
      });
    }
    await rm(path);
    await writeFile(join(root, 'linked.json'), JSON.stringify(config));
    await symlink('linked.json', path);
    await assert.rejects(readConfig(root), /non-symlink/);
    await rm(path);
    await mkdir(path);
    await assert.rejects(readConfig(root), /regular/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
