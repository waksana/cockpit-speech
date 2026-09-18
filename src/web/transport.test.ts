import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionClient } from './transport.ts';
import { MAX_RESPONSE_BYTES } from '../shared/limits.ts';

const session = () => ({ clientSecret: 'ephemeral-fixture', expiresAt: Math.floor(Date.now() / 1000) + 600,
  socketUrl: 'wss://synthetic.openai.azure.com/openai/v1/realtime?intent=transcription', deployment: 'dictation' });
const signal = () => new AbortController().signal;
test('credential requests never include context/audio; cached token expires early and config staleness is bounded', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  const client = sessionClient(async (path, init) => {
    calls++; assert.equal(path, '/session'); assert.equal(init?.body, '{}');
    return Response.json(session());
  });
  await client(signal()); await client(signal());
  assert.equal(calls, 1);
  t.mock.timers.tick(60_001);
  await client(signal()); assert.equal(calls, 2);
  await client(signal(), true); assert.equal(calls, 3, 'manual retry refreshes configuration/credentials');
});
test('near-expiry credentials are not reused; aborted or disposed requests cannot populate cache', async () => {
  let calls = 0;
  const client = sessionClient(async () => { calls++; return Response.json({ ...session(), expiresAt: Math.floor(Date.now() / 1000) + 20 }); });
  await client(signal()); await client(signal()); assert.equal(calls, 2);
  const lifetime = new AbortController();
  const disposable = sessionClient(async () => Response.json(session()), lifetime.signal);
  await disposable(signal()); lifetime.abort();
  await assert.rejects(disposable(signal()), { name: 'AbortError' });
  const controller = new AbortController();
  await assert.rejects(sessionClient(async () => {
    controller.abort(); return Response.json(session());
  })(controller.signal), { name: 'AbortError' });
});
test('safe configuration failures can be retried and never cache failures', async () => {
  let configured = false;
  const client = sessionClient(async () => configured ? Response.json(session())
    : Response.json({ error: { code: 'CONFIG_UNAVAILABLE', message: '请创建 azure-openai.json。' } }, { status: 503 }));
  await assert.rejects(client(signal()), /azure-openai\.json/);
  configured = true; await client(signal());
});
test('credentials must target exactly the allowlisted Azure WebSocket endpoint', async () => {
  for (const value of [{}, { ...session(), clientSecret: '' }, { ...session(), expiresAt: 1 },
    { ...session(), socketUrl: 'wss://example.com/' },
    { ...session(), socketUrl: session().socketUrl + '&Authorization=stolen' },
    { ...session(), socketUrl: session().socketUrl.replace('.com/', '.com:443/') },
    { ...session(), deployment: '../invalid' }]) {
    await assert.rejects(sessionClient(async () => Response.json(value))(signal()), { code: 'SESSION_INVALID' });
  }
});
test('malformed/oversized responses and network errors remain safe', async () => {
  for (const response of [new Response('invalid'), new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1))]) {
    await assert.rejects(sessionClient(async () => response)(signal()));
    assert.equal(response.body?.locked, false);
  }
  await assert.rejects(sessionClient(async () => { throw new Error('PRIVATE'); })(signal()),
    error => error instanceof Error && !error.message.includes('PRIVATE'));
});
