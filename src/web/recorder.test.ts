import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { prepareRecording } from './recorder.ts';
import type { AudioEnvironment, Recording } from './recorder.ts';
import { MAX_SECONDS, MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';

const session = () => ({ clientSecret: 'ephemeral-fixture', expiresAt: Math.floor(Date.now() / 1000) + 60,
  callsUrl: 'https://synthetic.openai.azure.com/openai/v1/realtime/calls' });
function fixture() {
  let stops = 0, closes = 0, peerCloses = 0, channelCloses = 0, captures = 0, resumed = 0, outputStops = 0;
  const errors: SpeechError[] = [];
  const sent: string[] = [];
  const gains: [number, number][] = [];
  const track = { stop: () => { stops++; }, onended: null as (() => void) | null };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  let grant!: (value: MediaStream) => void;
  const permission = new Promise<MediaStream>(resolve => { grant = resolve; });
  const channel = {
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    close: () => { channelCloses++; },
    send: (message: string) => {
      const value = JSON.parse(message);
      sent.push(value.type);
      if (value.type === 'input_audio_buffer.clear') emit('input_audio_buffer.cleared');
    },
  };
  const emit = (type: string, properties = {}) => channel.onmessage?.({ data: JSON.stringify({ type, ...properties }) });
  const source = { connect() {}, disconnect() {} };
  const gate = { connect() {}, disconnect() {}, gain: { setValueAtTime: (value: number, time: number) => gains.push([value, time]) } };
  const context = {
    currentTime: 3, state: 'running', onstatechange: null as (() => void) | null,
    resume: async () => { resumed++; }, close: async () => { closes++; },
    createMediaStreamSource: () => source,
    createGain: () => gate,
    createMediaStreamDestination: () => ({
      stream: { getTracks: () => [{ stop: () => { outputStops++; } }] }, disconnect() {},
    }),
  };
  const peer = {
    connectionState: 'connected',
    onconnectionstatechange: null as (() => void) | null,
    addTrack() {},
    createDataChannel: () => channel,
    createOffer: async (): Promise<RTCSessionDescriptionInit> => ({ type: 'offer', sdp: 'v=0\r\nsynthetic-offer' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => { channel.onopen?.(); },
    close: () => { peerCloses++; },
  };
  const env: AudioEnvironment = {
    secure: true, createContext: () => context as unknown as AudioContext,
    getUserMedia: () => { captures++; return permission; },
    createPeer: () => peer as unknown as RTCPeerConnection,
    fetch: async (url, init) => {
      assert.equal(url, session().callsUrl);
      assert.deepEqual(init?.headers, { Authorization: 'Bearer ephemeral-fixture', 'Content-Type': 'application/sdp' });
      assert.equal(init?.body, 'v=0\r\nsynthetic-offer'); assert.equal(init.redirect, 'error');
      return new Response('v=0\r\nsynthetic-answer', { status: 201 });
    },
  };
  const prepare = (signal = new AbortController().signal, limit = () => {}) =>
    prepareRecording(signal, error => errors.push(error), limit, env);
  const start = async (signal?: AbortSignal, limit?: () => void) => {
    const pending = prepare(signal, limit).start(session());
    grant(stream);
    return pending;
  };
  const commit = () => emit('input_audio_buffer.committed', { item_id: 'captured-item' });
  const complete = (text = 'recognized', item = 'captured-item') =>
    emit('conversation.item.input_audio_transcription.completed', { item_id: item, content_index: 0, transcript: text });
  return { env, peer, channel, context, track, stream, grant, emit, commit, complete, start, prepare, errors, sent, gains,
    values: () => ({ stops, closes, peerCloses, channelCloses, captures, resumed, outputStops }) };
}
async function flush(t: TestContext) {
  t.mock.timers.tick(250);
  await Promise.resolve();
}

test('gesture preparation unlocks audio but never asks for permission or contacts Azure before credentials', async () => {
  const f = fixture(); const preparation = f.prepare();
  assert.equal(f.values().resumed, 1); assert.equal(f.values().captures, 0);
  preparation.cancel();
  await assert.rejects(preparation.start(session()), { name: 'AbortError' });
  assert.equal(f.values().closes, 1);
});
test('cancel releases audio immediately and stops a late permission grant', async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = f.prepare(controller.signal).start(session());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  assert.equal(f.values().closes, 1);
  f.grant(f.stream);
  await rejected;
  assert.equal(f.values().stops, 1);
  assert.equal(f.values().peerCloses, 0);
});
test('valid credentials connect directly; stop drains RTP once and waits for the matching committed item', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const recording = await f.start();
  assert.deepEqual(f.sent, ['input_audio_buffer.clear']);
  assert.deepEqual(f.gains, [[1, 3], [0, 3 + MAX_SECONDS]]);
  let committed = 0;
  const result = recording.stop(() => { committed++; });
  assert.equal(recording.stop(), result);
  assert.equal(f.values().stops, 1);
  assert.equal(f.values().outputStops, 0, 'silent track drains remaining audio');
  await flush(t);
  assert.equal(committed, 1);
  assert.deepEqual(f.sent, ['input_audio_buffer.clear', 'input_audio_buffer.commit']);
  f.complete();
  assert.equal(f.values().closes, 0, 'completion waits for the matching commit acknowledgement');
  f.commit();
  assert.equal(await result, 'recognized');
  assert.deepEqual(f.values(), { stops: 1, closes: 1, peerCloses: 1, channelCloses: 1, captures: 1, resumed: 1, outputStops: 1 });
  recording.cancel();
  assert.equal(f.values().closes, 1);
});
test('cancel after commit rejects the pending result and ignores a late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const recording = await f.start();
  const pending = recording.stop(); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await flush(t);
  const late = f.channel.onmessage!;
  recording.cancel();
  late({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'captured-item', content_index: 0, transcript: 'late' }) });
  await rejected;
  assert.equal(f.values().closes, 1); assert.deepEqual(f.errors, []);
});
test('permission denial, expired credentials and failed SDP responses are safe and never retry', async () => {
  const insecure = fixture();
  assert.throws(() => prepareRecording(new AbortController().signal, () => {}, () => {}, { ...insecure.env, secure: false }), /HTTPS/);
  const expired = fixture();
  await assert.rejects(expired.prepare().start({ ...session(), expiresAt: 1 }), { code: 'SESSION_INVALID' });
  assert.equal(expired.values().captures, 0);
  const denied = fixture();
  denied.env.getUserMedia = async () => { throw new Error('PRIVATE_PERMISSION_DETAIL'); };
  await assert.rejects(denied.prepare().start(session()), error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal(denied.values().closes, 1);
  for (const response of [new Response('PRIVATE_PROVIDER_BODY', { status: 401 }), new Response('not SDP'), new Response('x'.repeat(65_537))]) {
    const f = fixture(); let requests = 0;
    f.env.fetch = async () => { requests++; return response; };
    await assert.rejects(f.start(), error => error instanceof Error && !error.message.includes('PRIVATE'));
    assert.equal(requests, 1); assert.equal(f.values().stops, 1); assert.equal(f.values().peerCloses, 1);
  }
});
test('cancellation during an unfinished WebRTC offer does not leak the peer or microphone', async () => {
  const f = fixture(); const controller = new AbortController();
  let offered!: () => void;
  const observed = new Promise<void>(resolve => { offered = resolve; });
  f.peer.createOffer = () => { offered(); return new Promise(() => {}); };
  const pending = f.start(controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await observed; controller.abort(); await rejected;
  assert.equal(f.values().stops, 1); assert.equal(f.values().peerCloses, 1);
});
test('cancelling preparation while waiting for buffer clear never admits microphone audio', async () => {
  const f = fixture();
  let requested!: () => void;
  const observed = new Promise<void>(resolve => { requested = resolve; });
  f.channel.send = message => {
    assert.equal(JSON.parse(message).type, 'input_audio_buffer.clear');
    requested();
  };
  const preparation = f.prepare();
  const pending = preparation.start(session());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  f.grant(f.stream);
  await observed;
  assert.deepEqual(f.gains, []);
  preparation.cancel();
  await rejected;
  assert.equal(f.values().stops, 1); assert.equal(f.values().outputStops, 1);
  assert.equal(f.values().peerCloses, 1); assert.equal(f.values().channelCloses, 1);
  assert.deepEqual(f.errors, []);
});
test('abort during pending SDP fetch closes resources even before the request settles', async () => {
  const f = fixture(); const controller = new AbortController();
  let requested!: () => void;
  const observed = new Promise<void>(resolve => { requested = resolve; });
  f.env.fetch = () => { requested(); return new Promise(() => {}); };
  const pending = f.start(controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await observed;
  controller.abort();
  await rejected;
  assert.equal(f.values().stops, 1); assert.equal(f.values().outputStops, 1);
  assert.equal(f.values().peerCloses, 1); assert.equal(f.values().closes, 1);
  assert.deepEqual(f.errors, []);
});
test('disconnect, microphone loss and suspended audio are explicit failures', async () => {
  for (const cause of ['peer', 'channel', 'track', 'context']) {
    const f = fixture(); await f.start();
    if (cause === 'peer') { f.peer.connectionState = 'disconnected'; f.peer.onconnectionstatechange!(); }
    if (cause === 'channel') f.channel.onclose!();
    if (cause === 'track') f.track.onended!();
    if (cause === 'context') { f.context.state = 'suspended'; f.context.onstatechange!(); }
    assert.equal(f.errors.length, 1); assert.equal(f.values().closes, 1); assert.equal(f.values().peerCloses, 1);
  }
});
test('two-minute wall limit stops hardware and automatically finalizes exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let limits = 0; let pending: Promise<string> | undefined;
  const recording: Recording = await f.start(undefined, () => { limits++; pending = recording.stop(); });
  t.mock.timers.tick(MAX_SECONDS * 1000);
  assert.equal(limits, 1); assert.equal(f.values().stops, 1);
  assert.equal(recording.stop(), pending);
  await flush(t); f.commit(); f.complete('bounded');
  assert.equal(await pending, 'bounded');
  assert.equal(f.sent.filter(type => type === 'input_audio_buffer.commit').length, 1);
});
test('wrong item, oversized or empty text and provider errors cannot become a transcript', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cause of ['wrong-item', 'large', 'empty', 'provider', 'malformed']) {
    const f = fixture(); const recording = await f.start();
    const pending = recording.stop(); const rejected = assert.rejects(pending);
    await flush(t); f.commit();
    if (cause === 'wrong-item') f.complete('text', 'another-item');
    if (cause === 'large') f.complete('x'.repeat(MAX_TEXT_POINTS + 1));
    if (cause === 'empty') f.complete(' ');
    if (cause === 'provider') f.emit('error', { error: { message: 'PRIVATE-PROVIDER-DETAIL' } });
    if (cause === 'malformed') f.channel.onmessage!({ data: 'bad json' });
    await rejected;
    assert.equal(f.errors.length, 1); assert.doesNotMatch(f.errors[0]!.message, /PRIVATE/);
  }
});
test('transcript deadline releases hardware, peer and pending promise', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const recording = await f.start();
  const pending = recording.stop(); const rejected = assert.rejects(pending, { code: 'PROVIDER_TIMEOUT' });
  await flush(t); t.mock.timers.tick(90_000); await rejected;
  assert.equal(f.values().peerCloses, 1); assert.equal(f.errors.length, 1);
});
