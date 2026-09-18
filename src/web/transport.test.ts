import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcriptionClient } from './transport.ts';
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
