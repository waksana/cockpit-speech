import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModuleBackendContext, ModuleRequest } from '@cockpit/module-api';
import { activate } from './index.ts';
import { MAX_JSON_BYTES } from '../shared/limits.ts';

const request = (body: unknown, signal = new AbortController().signal): ModuleRequest => ({ params: {}, query: {}, headers: {}, body, signal });
const config = { endpoint: 'https://synthetic.openai.azure.com', key: 'synthetic-key', deployment: 'dictation' };
const session = { clientSecret: 'ephemeral-fixture', expiresAt: 2_000_000_000,
  socketUrl: 'wss://synthetic.openai.azure.com/openai/v1/realtime?intent=transcription', deployment: config.deployment };
test('backend has one credential route, rereads file configuration and never returns the resource key', async () => {
  const dataRoot = resolve('.test-work', randomUUID()); await mkdir(dataRoot, { recursive: true });
  const controller = new AbortController();
  let requests = 0;
  const context: ModuleBackendContext = {
    apiVersion: 1, moduleId: 'cockpit-speech', dataRoot, apiBase: '/api/module',
    config: {}, signal: controller.signal, report: () => assert.fail('no private error should be reported'),
    invalidate() {}, publish() {},
  };
  const backend = activate(context, {
    issue: async config => { assert.equal(config.key, 'updated-synthetic-key'); requests++; return session; },
  });
  assert.deepEqual(backend.routes.map(route => [route.method, route.path]), [['POST', '/session']]);
  const route = backend.routes[0]!;
  assert.equal(route.bodyLimit, MAX_JSON_BYTES);
  assert.equal(backend.publicConfig, undefined); assert.equal(backend.events, undefined);
  try {
    const missing = await route.handler(request({}));
    assert.equal(missing.status, 503); assert.match(JSON.stringify(missing.body), /azure-openai.json/);
    assert.equal(requests, 0);
    const file = join(dataRoot, 'azure-openai.json');
    await writeFile(file, JSON.stringify(config));
    await writeFile(file, JSON.stringify({ ...config, key: 'updated-synthetic-key' }));
    const response = await route.handler(request({}));
    assert.deepEqual(response.body, session); assert.equal(response.headers?.['Cache-Control'], 'no-store');
    assert.doesNotMatch(JSON.stringify(response), /updated-synthetic-key/);
    assert.equal(requests, 1);
    for (const body of [{ context: 'private' }, { key: 'browser-key' }, { audio: 'AA==' }, { endpoint: 'https://example.com' }]) {
      assert.equal((await route.handler(request(body))).status, 400);
    }
    backend.dispose?.();
    assert.equal((await route.handler(request({}))).status, 499);
    assert.equal(requests, 1);
  } finally { backend.dispose?.(); await rm(dataRoot, { recursive: true, force: true }); }
});
test('backend bounds concurrent credential requests and combines request/module cancellation', async () => {
  const dataRoot = resolve('.test-work', randomUUID()); await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, 'azure-openai.json'), JSON.stringify(config));
  const controller = new AbortController();
  let started!: () => void;
  const observed = new Promise<void>(resolve => { started = resolve; });
  const backend = activate({
    apiVersion: 1, moduleId: 'cockpit-speech', dataRoot, apiBase: '/api/module', config: {}, signal: controller.signal,
    report() {}, invalidate() {}, publish() {},
  }, { issue: async (_config, _input, signal) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(new Error('private abort reason')), { once: true });
  }) });
  const route = backend.routes[0]!;
  try {
    const first = route.handler(request({})); await observed;
    assert.equal((await route.handler(request({}))).status, 409);
    controller.abort();
    const result = await first;
    assert.equal(result.status, 499); assert.doesNotMatch(JSON.stringify(result), /private/);
  } finally { backend.dispose?.(); await rm(dataRoot, { recursive: true, force: true }); }
});
