import assert from 'node:assert/strict';
import { test } from 'node:test';
import { azureTranscriber, boundedJson, definition, parseInput, parseTranscript } from './azure.ts';
import { MAX_RESPONSE_BYTES } from '../shared/limits.ts';
import { encodeWav } from '../shared/wav.ts';

const config = { endpoint: 'https://synthetic.cognitiveservices.azure.com', key: 'synthetic-not-a-real-key' };
const audio = encodeWav([new Float32Array([0.1, -0.2])], 2);
const body = { audio: Buffer.from(audio).toString('base64'), mime: 'audio/wav' };
const signal = () => new AbortController().signal;
test('typed browser input rejects unknown fields, URLs, bad base64, formats and oversized context', () => {
  for (const context of ['a'.repeat(1_000), '😀'.repeat(1_000)]) {
    assert.deepEqual(parseInput({ ...body, context }), { audio, context });
  }
  for (const invalid of [{ ...body, key: 'x' }, { ...body, endpoint: 'https://x' }, { ...body, audioUrl: 'https://x' },
    { ...body, context: '😀'.repeat(1_001) }, { ...body, context: 'a'.repeat(1_001) },
    { ...body, context: 1 }, { ...body, mime: 'audio/mp4' },
    { ...body, audio: 'AAAA===' }, { ...body, audio: 'Zg==\n' }, { ...body, audio: 'Zg==' }, null]) {
    assert.throws(() => parseInput(invalid));
  }
});
test('provider multipart uses enhanced transcribe only, fixed endpoint/header, no redirects or retries', async () => {
  let calls = 0;
  const context = '😀'.repeat(995) + 'final';
  const adapter = azureTranscriber(async (url, init) => {
    calls++;
    assert.equal(url, `${config.endpoint}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`);
    assert.deepEqual(init?.headers, { 'Ocp-Apim-Subscription-Key': config.key });
    assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
    const form = init?.body as FormData;
    const file = form.get('audio') as File;
    assert.equal(file.name, 'recording.wav'); assert.equal(file.type, 'audio/wav');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio);
    const options = JSON.parse(form.get('definition') as string);
    assert.deepEqual(options, definition(context));
    assert.equal(options.enhancedMode.task, 'transcribe');
    assert.match(options.enhancedMode.prompt[0]!, /not instructions or content to insert/);
    return Response.json({ combinedPhrases: [{ channel: 0, text: 'First' }, { text: '第二' }] });
  });
  assert.equal(await adapter.transcribe(config, parseInput({ ...body, context }), signal()), 'First\n第二');
  assert.equal(calls, 1);
});
test('combinedPhrases keeps mono array order and rejects wrong channels, shapes and silence', () => {
  assert.equal(parseTranscript({ combinedPhrases: [{ text: ' b ' }, { text: 'a' }] }), 'b\na');
  for (const invalid of [{}, { combinedPhrases: 'x' }, { combinedPhrases: [{ text: 1 }] },
    { combinedPhrases: [{ text: 'x', channel: 1 }] }, { combinedPhrases: [] }, { combinedPhrases: [{ text: ' ' }] }]) {
    assert.throws(() => parseTranscript(invalid));
  }
});
test('provider failures are safe and never echo provider bodies or raw fetch errors', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const adapter = azureTranscriber(async () => { calls++; return new Response('PRIVATE-PROVIDER-BODY', { status }); });
    await assert.rejects(adapter.transcribe(config, { audio }, signal()), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE|synthetic-not/);
      assert.match(error.message, status === 401 || status === 403 ? /鉴权失败/ : /HTTP/); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(azureTranscriber(async () => { throw new Error('PRIVATE-FETCH-DETAIL'); }).transcribe(config, { audio }, signal()), { code: 'PROVIDER_UNAVAILABLE' });
});
test('response reads are bounded even without content-length and release their reader', async () => {
  for (const response of [
    new Response('x', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
    new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)),
    new Response('not JSON'),
  ]) {
    await assert.rejects(boundedJson(response));
    assert.equal(response.body?.locked, false);
  }
});
test('provider honours cancellation and timeout without retry', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const unused = azureTranscriber(async () => { calls++; return Response.json({}); });
  await assert.rejects(unused.transcribe(config, { audio }, controller.signal), { code: 'CANCELLED' });
  assert.equal(calls, 0);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const waiting = azureTranscriber(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }), 5);
    await assert.rejects(waiting.transcribe(config, { audio }, signal()), { code: 'PROVIDER_TIMEOUT' });
  } finally { clearTimeout(keepAlive); }
});
