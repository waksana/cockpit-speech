import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { prepareRecording } from './recorder.ts';
import type { AudioEnvironment, Recording } from './recorder.ts';
import { MAX_SECONDS, MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';
import { SpeechService } from './speech.ts';
import type { ModuleDraft } from '@cockpit/module-api';

const session = () => ({ clientSecret: 'ephemeral-fixture', expiresAt: Math.floor(Date.now() / 1000) + 60,
  callsUrl: 'https://synthetic.openai.azure.com/openai/v1/realtime/calls' });
function fixture() {
  let stops = 0, closes = 0, peerCloses = 0, channelCloses = 0, captures = 0, resumed = 0, outputStops = 0;
  const errors: SpeechError[] = [];
  const sent: string[] = [];
  const gains: [number, number][] = [];
  const track = { kind: 'audio', readyState: 'live', enabled: true,
    stop: () => { stops++; track.readyState = 'ended'; track.onended?.(); }, onended: null as (() => void) | null };
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

function serviceFixture(f: ReturnType<typeof fixture>) {
  let leases = 0;
  const reports: Error[] = [];
  const draft: ModuleDraft = {
    id: 'exact-draft', sessionId: 's', purpose: { kind: 'prompt' },
    subscribe: () => () => {},
    getSnapshot: () => ({ text: '', revision: 0, pending: false, unconfirmed: false, hasContent: false, blocks: [] }),
    editText: () => assert.fail('Failure must never edit or submit'),
    block: () => { leases++; return () => { leases--; }; },
  };
  const service = new SpeechService({
    signal: new AbortController().signal,
    host: { getSnapshot: () => ({ sessionId: 's', visible: true, connected: true }), subscribe: () => () => {} },
    chatWindow: { getSnapshot: () => ({ sessionId: 's', status: 'unavailable', messages: [], hasMore: false, partial: false }), subscribe: () => () => {} },
    session: async () => session(),
    prepare: (signal, fail, limit) => prepareRecording(signal, error => { f.errors.push(error); fail(error); }, limit, f.env),
    report: error => reports.push(error),
  });
  service.setTarget({ draft, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  return { service, reports, leases: () => leases };
}

test('device/context failure throughout connection setup cleans resources and releases the actual service lease', async () => {
  for (const stage of ['offer', 'remote-description', 'channel-open', 'buffer-clear']) {
    for (const cause of ['track-ended', 'context-suspended']) {
      const f = fixture(); const s = serviceFixture(f);
      let reached!: () => void;
      const waiting = new Promise<void>(resolve => { reached = resolve; });
      if (stage === 'offer') f.peer.createOffer = () => { reached(); return new Promise(() => {}); };
      if (stage === 'remote-description') f.peer.setRemoteDescription = () => { reached(); return new Promise(() => {}); };
      if (stage === 'channel-open') f.peer.setRemoteDescription = async () => { reached(); };
      if (stage === 'buffer-clear') f.channel.send = () => { reached(); };
      const pending = s.service.start(); f.grant(f.stream); await waiting;
      assert.equal(s.leases(), 1); assert.equal(f.track.enabled, false); assert.deepEqual(f.gains, []);
      if (cause === 'track-ended') { f.track.readyState = 'ended'; f.track.onended!(); }
      else { f.context.state = 'suspended'; f.context.onstatechange!(); }
      await pending;
      assert.equal(s.service.getSnapshot().phase, 'idle');
      assert.ok(s.service.getSnapshot().error); assert.equal(s.service.canStart(), true);
      assert.equal(s.leases(), 0); assert.equal(f.errors.length, 1); assert.deepEqual(s.reports, []);
      assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
      assert.equal(f.values().peerCloses, 1); assert.equal(f.values().channelCloses, 1);
      assert.equal(f.values().outputStops, 1); assert.deepEqual(f.gains, []);
      s.service.dispose();
    }
  }
});
test('final readiness check rejects ended/missing audio tracks or suspended context even without a delivered event', async () => {
  for (const cause of ['ended', 'no-audio', 'suspended']) {
    const f = fixture();
    f.channel.send = () => {
      if (cause === 'ended') f.track.readyState = 'ended';
      if (cause === 'no-audio') f.track.kind = 'video';
      if (cause === 'suspended') f.context.state = 'suspended';
      f.emit('input_audio_buffer.cleared');
    };
    await assert.rejects(f.start(), { code: 'AUDIO_FAILED' });
    assert.equal(f.values().stops, 1); assert.equal(f.values().peerCloses, 1);
    assert.equal(f.values().closes, 1); assert.deepEqual(f.gains, []);
  }
});
test('initial suspended context may resume normally; later suspension before permission completion fails', async () => {
  const normal = fixture();
  normal.context.state = 'suspended';
  normal.context.resume = async () => {
    normal.context.onstatechange!();
    normal.context.state = 'running'; normal.context.onstatechange!();
  };
  const recording = await normal.start();
  assert.equal(normal.track.enabled, true); assert.deepEqual(normal.errors, []);
  recording.cancel(); assert.deepEqual(normal.errors, []);

  const f = fixture(); const s = serviceFixture(f);
  const pending = s.service.start();
  await Promise.resolve(); await Promise.resolve();
  f.context.state = 'suspended'; f.context.onstatechange!();
  await pending; f.grant(f.stream); await Promise.resolve();
  assert.equal(s.leases(), 0); assert.equal(f.errors.length, 1); assert.ok(s.service.getSnapshot().error);
  assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
  s.service.dispose();
});
test('preparation timeouts bound permission, resume and all connection waits and release service leases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stage of ['permission', 'resume', 'offer', 'channel', 'clear']) {
    const f = fixture(); const s = serviceFixture(f);
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    if (stage === 'permission') f.env.getUserMedia = () => { reached(); return new Promise(() => {}); };
    if (stage === 'resume') f.context.resume = () => { reached(); return new Promise(() => {}); };
    if (stage === 'offer') f.peer.createOffer = () => { reached(); return new Promise(() => {}); };
    if (stage === 'channel') f.peer.setRemoteDescription = async () => { reached(); };
    if (stage === 'clear') f.channel.send = () => { reached(); };
    const pending = s.service.start();
    if (stage !== 'permission') f.grant(f.stream);
    await waiting; await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(30_000); await pending;
    assert.equal(s.leases(), 0); assert.equal(s.service.getSnapshot().phase, 'idle');
    assert.equal(f.errors.length, 1); assert.ok(s.service.getSnapshot().error); assert.equal(f.values().closes, 1);
    assert.equal(f.values().stops, stage === 'permission' ? 0 : 1);
    assert.equal(f.values().peerCloses, ['permission', 'resume'].includes(stage) ? 0 : 1);
    s.service.dispose();
  }
});

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
  f.context.state = 'suspended'; f.context.onstatechange!();
  assert.deepEqual(f.errors, [], 'intentional stop and late audio state changes do not report failure');
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
test('final timeout releases the actual service lease and permits a fresh recording', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const s = serviceFixture(f);
  const started = s.service.start(); f.grant(f.stream); await started;
  const stopped = s.service.stop();
  await flush(t);
  assert.equal(s.service.getSnapshot().phase, 'transcribing'); assert.equal(s.leases(), 1);
  t.mock.timers.tick(90_000); await stopped;
  assert.equal(s.service.getSnapshot().phase, 'idle'); assert.equal(s.leases(), 0);
  assert.ok(s.service.getSnapshot().error); assert.equal(s.service.canStart(), true);
  assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
  assert.equal(f.values().peerCloses, 1); assert.equal(f.values().outputStops, 1);
  s.service.dispose();
});
