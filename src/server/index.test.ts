import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModuleBackendContext, ModuleRequest } from '@cockpit/module-api';
import { activate } from './index.ts';
import { encodeWav } from '../shared/wav.ts';
import { MAX_JSON_BYTES } from '../shared/limits.ts';

const request = (body: unknown, signal = new AbortController().signal): ModuleRequest => ({ params: {}, query: {}, headers: {}, body, signal });
test('backend activates without configuration; readiness has no secrets and file updates work without reactivation', async () => {
  const dataRoot = resolve('.test-work', randomUUID()); await mkdir(dataRoot, { recursive: true });
  const controller = new AbortController();
  let requests = 0;
  const context: ModuleBackendContext = {
    apiVersion: 1, moduleId: 'cockpit-speech', dataRoot, apiBase: '/api/module',
    config: {}, signal: controller.signal, report: () => assert.fail('no private error should be reported'),
    invalidate() {}, publish() {},
  };
  const backend = activate(context, {
    transcribe: async config => { assert.equal(config.key, 'updated-synthetic-key'); requests++; return 'recognized text'; },
  });
  const ready = backend.routes.find(route => route.path === '/config-ready')!;
  const transcribe = backend.routes.find(route => route.path === '/transcribe')!;
  assert.equal(transcribe.bodyLimit, MAX_JSON_BYTES);
  assert.equal(backend.publicConfig, undefined); assert.equal(backend.events, undefined);
  const body = { audio: Buffer.from(encodeWav([new Float32Array([0.1])], 1)).toString('base64'), mime: 'audio/wav' };
  try {
    const missing = await ready.handler(request(undefined));
    assert.equal(missing.status, 503); assert.match(JSON.stringify(missing.body), /azure-speech.json/);
    assert.equal((await transcribe.handler(request(body))).status, 503); assert.equal(requests, 0);
    const file = join(dataRoot, 'azure-speech.json');
    await writeFile(file, JSON.stringify({ endpoint: 'https://synthetic.cognitiveservices.azure.com', key: 'first-synthetic-key' }));
    const response = await ready.handler(request(undefined));
    assert.deepEqual(response.body, { ready: true }); assert.equal(response.headers?.['Cache-Control'], 'no-store');
    assert.doesNotMatch(JSON.stringify(response), /synthetic/);
    await writeFile(file, JSON.stringify({ endpoint: 'https://synthetic.cognitiveservices.azure.com', key: 'updated-synthetic-key' }));
    assert.deepEqual((await transcribe.handler(request(body))).body, { text: 'recognized text' });
    assert.equal(requests, 1);
    assert.equal((await transcribe.handler(request({ ...body, key: 'browser-key' }))).status, 400);
    backend.dispose?.();
    assert.equal((await transcribe.handler(request(body))).status, 499);
    assert.equal(requests, 1);
  } finally { backend.dispose?.(); await rm(dataRoot, { recursive: true, force: true }); }
});
test('backend allows one in-memory provider request and combines request/module cancellation', async () => {
  const dataRoot = resolve('.test-work', randomUUID()); await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, 'azure-speech.json'), JSON.stringify({ endpoint: 'https://synthetic.cognitiveservices.azure.com', key: 'synthetic-key' }));
  const controller = new AbortController();
  let started!: () => void;
  const observed = new Promise<void>(resolve => { started = resolve; });
  const backend = activate({
    apiVersion: 1, moduleId: 'cockpit-speech', dataRoot, apiBase: '/api/module', config: {}, signal: controller.signal,
    report() {}, invalidate() {}, publish() {},
  }, { transcribe: async (_config, _input, signal) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(new Error('private abort reason')), { once: true });
  }) });
  const route = backend.routes.find(x => x.path === '/transcribe')!;
  const body = { audio: Buffer.from(encodeWav([new Float32Array([0.1])], 1)).toString('base64'), mime: 'audio/wav' };
  try {
    const first = route.handler(request(body)); await observed;
    assert.equal((await route.handler(request(body))).status, 409);
    controller.abort();
    const result = await first;
    assert.equal(result.status, 499); assert.doesNotMatch(JSON.stringify(result), /private/);
  } finally { backend.dispose?.(); await rm(dataRoot, { recursive: true, force: true }); }
});
