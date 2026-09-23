import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseConfig, readConfig, WSL2_GUIDE_URL } from './config.ts';

const config = { endpoint: 'https://synthetic-resource.openai.azure.com/', key: 'synthetic-test-key-not-valid', deployment: 'gpt-transcribe' };
test('config accepts only exact fields and a public Azure resource origin', () => {
  assert.deepEqual(parseConfig(config), { ...config, endpoint: config.endpoint.slice(0, -1) });
  for (const endpoint of ['http://x.openai.azure.com', 'https://x.openai.azure.com:443',
    'https://x.openai.azure.com/path', 'https://x.openai.azure.com?secret=1',
    'https://user@x.openai.azure.com', 'https://x.openai.azure.com.evil.invalid',
    'https://localhost', 'https://127.0.0.1', 'https://x.api.cognitive.microsoft.com',
    'https://x.cognitiveservices.azure.com', 'https://-x.openai.azure.com', 'https://x-.openai.azure.com']) {
    assert.throws(() => parseConfig({ ...config, endpoint }), { code: 'CONFIG_ENDPOINT' });
  }
  for (const invalid of [{}, null, [], { ...config, other: true }, { ...config, key: '' },
    { ...config, key: 'a\nb' }, { ...config, key: 'secret ' }, { endpoint: 1, key: 'test' },
    { ...config, deployment: '' }, { ...config, deployment: '../model' }, { ...config, deployment: 'a'.repeat(65) }]) {
    assert.throws(() => parseConfig(invalid));
  }
});
test('config is reread, bounded, non-symlink and never exposes its bytes on errors', async () => {
  const root = resolve('.test-work', randomUUID());
  await mkdir(root, { recursive: true });
  const path = join(root, 'azure-openai.json');
  try {
    await writeFile(join(root, 'azure-speech.json'), JSON.stringify(config));
    await assert.rejects(readConfig(root), /azure-openai.json.*endpoint.*key/);
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
    await assert.rejects(readConfig(root), { code: 'CONFIG_UNAVAILABLE' });
    await rm(path);
    await mkdir(path);
    await assert.rejects(readConfig(root), { code: 'CONFIG_UNAVAILABLE' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('non-Linux platforms refuse config reads instead of opening without O_NOFOLLOW', async () => {
  const root = resolve('.test-work', randomUUID());
  await mkdir(root, { recursive: true });
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    await writeFile(join(root, 'azure-openai.json'), JSON.stringify(config), { mode: 0o600 });
    for (const platform of ['win32', 'darwin'] as const) {
      Object.defineProperty(process, 'platform', { ...original, value: platform });
      await assert.rejects(readConfig(root), error => {
        assert.ok(error instanceof Error && 'code' in error && error.code === 'UNSUPPORTED_PLATFORM');
        assert.equal(error.message, `语音模块需要 Linux（当前平台：${platform}）。Windows 请在 WSL2 中运行 Cockpit：${WSL2_GUIDE_URL}`);
        assert.doesNotMatch(error.message, /synthetic-test-key/);
        return true;
      });
    }
    Object.defineProperty(process, 'platform', original);
    assert.equal((await readConfig(root)).key, config.key);
  } finally {
    Object.defineProperty(process, 'platform', original);
    await rm(root, { recursive: true, force: true });
  }
});
