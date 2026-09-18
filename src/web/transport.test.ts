import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readinessClient, transcriptionClient } from './transport.ts';
import { MAX_RESPONSE_BYTES } from '../shared/limits.ts';

test('browser transport uses only module request, bounded typed body and no session/key/path', async () => {
  const signal = new AbortController().signal;
  const client = transcriptionClient(async (path, init) => {
    assert.equal(path, '/transcribe'); assert.equal(init?.method, 'POST'); assert.equal(init?.signal, signal);
    assert.deepEqual(JSON.parse(init?.body as string), { audio: 'AQID', mime: 'audio/wav', context: 'context' });
    return Response.json({ text: 'recognized' });
  });
  assert.equal(await client(new Uint8Array([1, 2, 3]), 'context', signal), 'recognized');
});
test('readiness checks the fixed module endpoint without credentials/audio and rereads on each explicit call', async () => {
  let configured = false;
  let requests = 0;
  const ready = readinessClient(async (path, init) => {
    requests++;
    assert.equal(path, '/config-ready');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    return configured ? Response.json({ ready: true })
      : Response.json({ error: { code: 'CONFIG_UNAVAILABLE', message: '请创建 azure-speech.json。' } }, { status: 503 });
  });
  await assert.rejects(ready(new AbortController().signal), /azure-speech\.json/);
  configured = true;
  await ready(new AbortController().signal);
  assert.equal(requests, 2);
});

test('readiness cancellation propagates to the request and cannot become permission to record', async () => {
  const controller = new AbortController();
  const ready = readinessClient(async (_path, init) => {
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    return Response.json({ ready: true });
  });
  await assert.rejects(ready(controller.signal), { name: 'AbortError' });
  for (const body of [{ ready: false }, {}, { ready: 'yes' }]) {
    await assert.rejects(readinessClient(async () => Response.json(body))(new AbortController().signal));
  }
});
test('browser transport surfaces safe backend errors and rejects malformed, blank or oversized results', async () => {
  for (const response of [
    Response.json({ error: { code: 'CONFIG_UNAVAILABLE', message: 'Create azure-speech.json with endpoint and key.' } }, { status: 503 }),
    Response.json({ text: '' }), Response.json({ text: 3 }), new Response('invalid'),
    new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)),
  ]) {
    await assert.rejects(transcriptionClient(async () => response)(new Uint8Array([1]), undefined, new AbortController().signal));
    assert.equal(response.body?.locked, false);
  }
});
