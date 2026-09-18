import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionClient } from './transport.ts';
import { MAX_RESPONSE_BYTES } from '../shared/limits.ts';

const session = () => ({ clientSecret: 'ephemeral-fixture', expiresAt: Math.floor(Date.now() / 1000) + 60,
  callsUrl: 'https://synthetic.openai.azure.com/openai/v1/realtime/calls' });
test('browser asks only for a session with context, never sends audio or credentials to the module', async () => {
  const client = sessionClient(async (path, init) => {
    assert.equal(path, '/session'); assert.equal(init?.method, 'POST');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), { context: 'context' });
    return Response.json(session());
  });
  assert.equal((await client('context', new AbortController().signal)).clientSecret, 'ephemeral-fixture');
});
test('each explicit start rereads configuration; credential cancellation cannot start recording', async () => {
  let configured = false, requests = 0;
  const client = sessionClient(async () => {
    requests++;
    return configured ? Response.json(session())
      : Response.json({ error: { code: 'CONFIG_UNAVAILABLE', message: '请创建 azure-openai.json。' } }, { status: 503 });
  });
  await assert.rejects(client(undefined, new AbortController().signal), /azure-openai\.json/);
  configured = true;
  await client(undefined, new AbortController().signal);
  assert.equal(requests, 2);
  const controller = new AbortController();
  await assert.rejects(sessionClient(async (_path, init) => {
    controller.abort(); assert.equal(init?.signal?.aborted, true); return Response.json(session());
  })(undefined, controller.signal), { name: 'AbortError' });
});
test('credentials must be current and target the fixed Azure WebRTC path', async () => {
  for (const value of [{}, { ...session(), clientSecret: '' }, { ...session(), expiresAt: 1 },
    { ...session(), callsUrl: 'https://example.com/calls' },
    { ...session(), callsUrl: 'https://synthetic.openai.azure.com/openai/v1/realtime/calls?other=true' },
    { ...session(), callsUrl: 'https://synthetic.openai.azure.com:443/openai/v1/realtime/calls' }]) {
    await assert.rejects(sessionClient(async () => Response.json(value))(undefined, new AbortController().signal), { code: 'SESSION_INVALID' });
  }
});
test('malformed/oversized responses and network errors remain safe', async () => {
  for (const response of [new Response('invalid'), new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1))]) {
    await assert.rejects(sessionClient(async () => response)(undefined, new AbortController().signal));
    assert.equal(response.body?.locked, false);
  }
  await assert.rejects(sessionClient(async () => { throw new Error('PRIVATE'); })(undefined, new AbortController().signal),
    error => error instanceof Error && !error.message.includes('PRIVATE'));
});
