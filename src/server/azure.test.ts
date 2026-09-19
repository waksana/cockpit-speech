import assert from 'node:assert/strict';
import { test } from 'node:test';
import { azureSessionIssuer, boundedJson, definition, parseInput } from './azure.ts';
import { MAX_RESPONSE_BYTES } from '../shared/limits.ts';

const config = { endpoint: 'https://synthetic.openai.azure.com', key: 'synthetic-not-a-real-key', deployment: 'dictation' };
const signal = () => new AbortController().signal;
const response = () => ({ value: 'synthetic-short-lived-secret', expires_at: Math.floor(Date.now() / 1000) + 60, session: { type: 'transcription' } });
test('session input accepts only an empty object, never context, audio, credentials or model options', () => {
  assert.deepEqual(parseInput({}), {});
  for (const invalid of [{ key: 'x' }, { endpoint: 'https://x' }, { audio: 'AA==' }, { model: 'other' },
    { context: '😀'.repeat(1_001) }, { context: 'a'.repeat(1_001) }, { context: 1 }, null]) assert.throws(() => parseInput(invalid));
});
test('issuer uses the key only server-side, fixed GA path and context-free transcription credentials', async () => {
  let calls = 0;
  const issued = response();
  const issuer = azureSessionIssuer(async (url, init) => {
    calls++;
    assert.equal(url, `${config.endpoint}/openai/v1/realtime/client_secrets`);
    assert.deepEqual(init?.headers, { 'api-key': config.key, 'Content-Type': 'application/json' });
    assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, definition(config.deployment));
    assert.equal(body.session.type, 'transcription');
    assert.equal(body.session.audio.input.turn_detection, null);
    assert.equal(body.session.audio.input.transcription.model, 'dictation');
    assert.ok(typeof body.session.audio.input.transcription.prompt === 'string');
    assert.equal(body.session.audio.input.transcription.prompt, '');
    return Response.json(issued);
  });
  const result = await issuer.issue(config, {}, signal());
  assert.deepEqual(result, { clientSecret: issued.value, expiresAt: issued.expires_at,
    socketUrl: 'wss://synthetic.openai.azure.com/openai/v1/realtime?intent=transcription', deployment: 'dictation' });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-not-a-real-key/);
  assert.equal(calls, 1);
});
test('credentials have a bounded lifetime, empty prompt and explicit PCM format', () => {
  assert.equal(definition(config.deployment).expires_after.seconds, 600);
  assert.deepEqual(definition(config.deployment).session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(definition(config.deployment).session.audio.input.transcription.prompt, '');
});
test('issuer rejects missing/expired credentials and conversation sessions', async () => {
  for (const value of [{}, { ...response(), value: '' }, { ...response(), expires_at: 1 },
    { ...response(), session: { type: 'realtime' } }, { ...response(), value: 'secret\nheader' }]) {
    await assert.rejects(azureSessionIssuer(async () => Response.json(value)).issue(config, {}, signal()));
  }
});
test('provider failures never echo private response bodies or raw fetch errors', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const issuer = azureSessionIssuer(async () => { calls++; return new Response('PRIVATE-PROVIDER-BODY', { status }); });
    await assert.rejects(issuer.issue(config, {}, signal()), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE|synthetic-not/);
      assert.match(error.message, status === 401 || status === 403 ? /鉴权失败/ : /HTTP/); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(azureSessionIssuer(async () => { throw new Error('PRIVATE-FETCH-DETAIL'); }).issue(config, {}, signal()), { code: 'PROVIDER_UNAVAILABLE' });
});
test('response reads are bounded and release their reader', async () => {
  for (const response of [
    new Response('x', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
    new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)), new Response('not JSON'),
  ]) {
    await assert.rejects(boundedJson(response));
    assert.equal(response.body?.locked, false);
  }
});
test('issuer honours cancellation and timeout without retry', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(azureSessionIssuer(async () => { calls++; return Response.json({}); }).issue(config, {}, controller.signal), { code: 'CANCELLED' });
  assert.equal(calls, 0);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const waiting = azureSessionIssuer(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }), 5);
    await assert.rejects(waiting.issue(config, {}, signal()), { code: 'PROVIDER_TIMEOUT' });
  } finally { clearTimeout(keepAlive); }
});
