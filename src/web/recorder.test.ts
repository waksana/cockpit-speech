import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModuleDraft } from '@cockpit/module-api';
import { prepareRecording } from './recorder.ts';
import type { AudioEnvironment } from './recorder.ts';
import { SpeechService } from './speech.ts';
import { PcmEncoder, PCM_LIMIT } from './pcm.ts';
import { transcriptionPrompt } from './socket.ts';
import { MAX_SECONDS, MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';

const credential = () => ({ clientSecret: 'synthetic-ephemeral', expiresAt: Math.floor(Date.now() / 1000) + 600,
  socketUrl: 'wss://synthetic.openai.azure.com/openai/v1/realtime?intent=transcription', deployment: 'dictation' });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const pump = () => new Promise<void>(resolve => setTimeout(resolve, 25));
function fixture() {
  let stops = 0, closes = 0, captures = 0;
  const errors: SpeechError[] = [];
  const track = { kind: 'audio', readyState: 'live', onended: null as (() => void) | null,
    stop() { stops++; this.readyState = 'ended'; this.onended?.(); } };
  const stream = { getTracks: () => [track], getAudioTracks: () => track.kind === 'audio' ? [track] : [] } as unknown as MediaStream;
  let grant!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>(resolve => { grant = resolve; });
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(_value: unknown) { queueMicrotask(() => port.onmessage?.({ data: { type: 'ended', limited: false } })); },
    close() {},
  };
  const worklet = { port, onprocessorerror: null as (() => void) | null, connect() {}, disconnect() {} };
  const context = {
    state: 'running', onstatechange: null as (() => void) | null, destination: {},
    audioWorklet: { addModule: async (_url: URL) => {} },
    resume: async () => {}, close: async () => { closes++; context.state = 'closed'; context.onstatechange?.(); },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  };
  class Socket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    bufferedAmount = 0;
    closed = 0;
    autoConfig = true;
    sent: Record<string, unknown>[] = [];
    send(raw: string) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.type === 'session.update' && this.autoConfig) this.emit('session.updated', { session: message.session });
    }
    close() { this.closed++; }
    emit(type: string, value = {}) { this.onmessage?.({ data: JSON.stringify({ type, ...value }) }); }
    commit() { this.emit('input_audio_buffer.committed', { item_id: 'same-provider-id' }); }
    final(transcript = 'recognized', item_id = 'same-provider-id') {
      this.emit('conversation.item.input_audio_transcription.completed', { item_id, content_index: 0, transcript });
    }
  }
  const sockets: Socket[] = [];
  const env: AudioEnvironment = {
    secure: true, createContext: () => context as unknown as AudioContext,
    getUserMedia: () => { captures++; return permission; },
    createWorklet: () => worklet as unknown as AudioWorkletNode,
    openSocket: url => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'wss://synthetic.openai.azure.com');
      assert.equal(parsed.searchParams.get('Authorization'), 'Bearer synthetic-ephemeral');
      const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.onopen?.());
      return socket as unknown as WebSocket;
    },
  };
  const prepare = (signal = new AbortController().signal, limit = () => {}) =>
    prepareRecording(signal, error => errors.push(error), limit, env);
  const start = async (context?: string) => {
    const preparation = prepare();
    const recording = preparation.start(async () => credential(), context);
    grant(stream); return recording;
  };
  const pcm = (marker = 1) => { const buffer = new ArrayBuffer(4800); new Uint8Array(buffer)[0] = marker; port.onmessage?.({ data: { type: 'pcm', buffer } }); };
  return { env, sockets, prepare, start, grant, stream, track, context, worklet, pcm, errors,
    values: () => ({ stops, closes, captures }) };
}
function serviceFixture(f: ReturnType<typeof fixture>) {
  let leases = 0;
  const draft: ModuleDraft = {
    id: 'exact-input', sessionId: 's', purpose: { kind: 'prompt' },
    subscribe: () => () => {},
    getSnapshot: () => ({ text: '', revision: 0, pending: false, unconfirmed: false, hasContent: false, blocks: [] }),
    editText: () => assert.fail('Failure must not edit'),
    block: () => { leases++; let held = true; return () => { if (held) leases--; held = false; }; },
  };
  const service = new SpeechService({
    signal: new AbortController().signal,
    host: { getSnapshot: () => ({ sessionId: 's', visible: true, connected: true }), subscribe: () => () => {} },
    chatWindow: { getSnapshot: () => ({ sessionId: 's', status: 'unavailable', messages: [], hasMore: false, partial: false }), subscribe: () => () => {} },
    session: async () => credential(),
    prepare: (signal, fail, limit) => prepareRecording(signal, fail, limit, f.env), report: () => assert.fail('No error notification'),
  });
  service.setTarget({ draft, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  return { service, leases: () => leases };
}

test('gesture starts microphone independently of unresolved credentials; stopped audio waits without loss', async () => {
  const f = fixture();
  let issue!: (value: ReturnType<typeof credential>) => void;
  const preparation = f.prepare();
  assert.equal(f.values().captures, 1);
  const starting = preparation.start(() => new Promise(resolve => { issue = resolve; }), 'captured context');
  f.grant(f.stream);
  const recording = await starting;
  f.pcm(1); f.pcm(2);
  const stopped = recording.stop();
  assert.equal(f.values().stops, 1);
  await turn(); assert.equal(f.sockets.length, 0);
  issue(credential()); await pump();
  const socket = f.sockets[0]!;
  assert.deepEqual(socket.sent.map(m => m.type), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
  const update = socket.sent[0] as { session: { audio: { input: { transcription: { prompt: string } } } } };
  assert.equal(update.session.audio.input.transcription.prompt, 'Reference vocabulary:\ncaptured context');
  socket.final(); socket.commit();
  assert.equal(await stopped, 'recognized');
  assert.equal(socket.closed, 1);
  recording.cancel();
});
test('prompt is confirmed before audio, including explicit empty context on cached credentials', async () => {
  const f = fixture();
  const original = f.env.openSocket;
  f.env.openSocket = url => { const socket = original(url); f.sockets.at(-1)!.autoConfig = false; return socket; };
  const recording = await f.start();
  f.pcm(); await pump();
  const socket = f.sockets[0]!;
  assert.deepEqual(socket.sent.map(m => m.type), ['session.update']);
  const session = socket.sent[0]!.session;
  assert.match(JSON.stringify(session), /"prompt":""/);
  socket.emit('session.updated', { session });
  const stop = recording.stop(); await pump();
  socket.commit(); socket.final(); await stop; recording.cancel();
  for (const text of ['a'.repeat(1000), '😀'.repeat(1000)]) assert.equal([...transcriptionPrompt(text)].length, 1022);
  assert.throws(() => transcriptionPrompt('a'.repeat(1001)));
});
test('live levels come from captured PCM without changing buffered bytes or surviving cancellation', async () => {
  const f = fixture(); const levels: number[] = [];
  const starting = f.prepare().start(async () => credential(), undefined, { waitForStop: true, onLevel: value => levels.push(value) });
  f.grant(f.stream); const recording = await starting;
  const buffer = new ArrayBuffer(4800);
  const view = new DataView(buffer);
  for (let i = 0; i < 2400; i++) view.setInt16(i * 2, i % 2 ? -8192 : 8192, true);
  f.worklet.port.onmessage?.({ data: { type: 'pcm', buffer } });
  assert.deepEqual(levels, [0.25]);
  assert.equal(view.getInt16(0, true), 8192);
  recording.cancel(); f.pcm();
  assert.deepEqual(levels, [0.25]);
  assert.equal(recording.retryable(), false);
});
test('held audio hitting either limit stops hardware but never commits until release, and exit discards it', async t => {
  for (const limit of ['render', 'wall'] as const) for (const action of ['release', 'exit'] as const) {
    await t.test(`${limit} limit then ${action}`, async t => {
      const f = fixture(); let limited = 0;
      if (limit === 'wall') t.mock.timers.enable({ apis: ['setTimeout'] });
      const preparation = f.prepare(undefined, () => { limited++; });
      const starting = preparation.start(async () => credential(), 'held context', { waitForStop: true });
      f.grant(f.stream); const recording = await starting; f.pcm();
      const drain = async () => {
        if (limit === 'wall') { t.mock.timers.tick(25); await turn(); }
        else await pump();
      };
      await drain();
      if (limit === 'render') f.worklet.port.onmessage?.({ data: { type: 'ended', limited: true } });
      else t.mock.timers.tick(MAX_SECONDS * 1000);
      await turn(); await drain();
      assert.equal(limited, 1);
      assert.equal(f.track.readyState, 'ended');
      assert.equal(f.values().closes, 1);
      const socket = f.sockets[0]!;
      assert.equal(socket.sent.filter(m => m.type === 'input_audio_buffer.commit').length, 0);
      assert.equal(recording.retryable(), true);
      if (action === 'release') {
        const stopped = recording.stop(); await drain();
        assert.equal(socket.sent.filter(m => m.type === 'input_audio_buffer.commit').length, 1);
        socket.commit(); socket.final(); assert.equal(await stopped, 'recognized');
      } else {
        recording.cancel(); await drain();
        assert.equal(recording.retryable(), false);
        assert.equal(socket.closed, 1);
        assert.equal(socket.sent.filter(m => m.type === 'input_audio_buffer.commit').length, 0);
      }
      recording.cancel();
    });
  }
});
test('failed send closes its connection; manual retry replays the identical retained chunks with a fresh cursor', async () => {
  const f = fixture(); const recording = await f.start('original prompt');
  f.pcm(11); f.pcm(22); await pump();
  const old = f.sockets[0]!;
  const late = old.onmessage;
  const firstAudio = old.sent.filter(m => m.type === 'input_audio_buffer.append').map(m => m.audio);
  old.onclose?.();
  await assert.rejects(recording.stop(), { code: 'CONNECTION_CLOSED' });
  assert.equal(recording.retryable(), true); assert.equal(old.closed, 1);
  const retried = recording.retry(); await pump();
  const next = f.sockets[1]!;
  assert.deepEqual(next.sent.filter(m => m.type === 'input_audio_buffer.append').map(m => m.audio), firstAudio);
  late?.({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'same-provider-id', content_index: 0, transcript: 'stale' }) });
  next.commit(); next.final('fresh');
  assert.equal(await retried, 'fresh');
  assert.equal(f.values().captures, 1); recording.cancel(); assert.equal(recording.retryable(), false);
});
test('stop flushes tail samples before its single commit; intentional stop does not report audio errors', async () => {
  const f = fixture(); const recording = await f.start(); f.pcm(1);
  f.worklet.port.postMessage = () => queueMicrotask(() => {
    f.pcm(2); f.worklet.port.onmessage?.({ data: { type: 'ended', limited: false } });
  });
  const stop = recording.stop();
  assert.equal(stop, recording.stop());
  await pump();
  const socket = f.sockets[0]!;
  assert.equal(socket.sent.filter(m => m.type === 'input_audio_buffer.append').length, 2);
  assert.equal(socket.sent.filter(m => m.type === 'input_audio_buffer.commit').length, 1);
  assert.deepEqual(f.errors, []); socket.commit(); socket.final(); await stop; recording.cancel();
});
test('late audio-context cleanup failure cannot abort a newer replay attempt', async () => {
  const f = fixture();
  let rejectClose!: (error: Error) => void;
  f.context.close = () => new Promise((_resolve, reject) => { rejectClose = reject; });
  const recording = await f.start(); f.pcm(); await pump();
  f.sockets[0]!.onclose?.();
  await assert.rejects(recording.stop(), { code: 'CONNECTION_CLOSED' });
  const replay = recording.retry(); await pump();
  rejectClose(new Error('Synthetic late cleanup rejection')); await turn();
  assert.deepEqual(f.errors, []);
  const socket = f.sockets[1]!;
  assert.equal(socket.closed, 0);
  socket.commit(); socket.final();
  assert.equal(await replay, 'recognized'); recording.cancel();
});
test('device/context failures during initialization and capture release service leases; audio may remain retryable', async () => {
  for (const stage of ['initialization', 'recording']) for (const cause of ['track', 'context']) {
    const f = fixture(); const s = serviceFixture(f);
    let loaded!: () => void;
    if (stage === 'initialization') f.context.audioWorklet.addModule = () => new Promise(resolve => { loaded = resolve; });
    const start = s.service.start(); f.grant(f.stream); await turn();
    if (stage === 'recording') { await start; f.pcm(); }
    if (cause === 'track') { f.track.readyState = 'ended'; f.track.onended?.(); }
    else { f.context.state = 'suspended'; f.context.onstatechange?.(); }
    if (stage === 'initialization') loaded();
    await start; await turn();
    assert.equal(s.leases(), 0); assert.equal(s.service.getSnapshot().phase, 'retry');
    assert.ok(s.service.getSnapshot().error); assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
    s.service.dispose();
  }
});
test('normal initial resume is allowed; silent invalid track/context states fail the final capture check', async () => {
  const f = fixture(); f.context.state = 'suspended';
  f.context.resume = async () => { f.context.onstatechange?.(); f.context.state = 'running'; f.context.onstatechange?.(); };
  const recording = await f.start(); recording.cancel(); assert.deepEqual(f.errors, []);
  for (const cause of ['ended', 'video', 'suspended']) {
    const f = fixture();
    f.context.audioWorklet.addModule = async () => {
      if (cause === 'ended') f.track.readyState = 'ended';
      if (cause === 'video') f.track.kind = 'video';
      if (cause === 'suspended') f.context.state = 'suspended';
    };
    await assert.rejects(f.start(), { code: 'AUDIO_FAILED' });
    assert.equal(f.values().closes, 1);
  }
});
test('a pre-permission resume parked by WebKit is re-evaluated once capture is granted', async () => {
  const f = fixture(); const s = serviceFixture(f);
  f.context.state = 'suspended';
  let resumes = 0;
  let granted = false;
  let resolveInitial!: () => void;
  f.context.resume = () => {
    resumes++;
    if (!granted) return new Promise(resolve => { resolveInitial = resolve; });
    f.context.state = 'running'; f.context.onstatechange?.();
    resolveInitial(); return Promise.resolve();
  };
  const starting = s.service.start('hold');
  await turn();
  assert.equal(resumes, 1);
  assert.equal(s.service.getSnapshot().phase, 'permission');
  assert.equal(s.leases(), 1);
  granted = true; f.grant(f.stream); await starting;
  assert.equal(resumes, 2);
  assert.equal(f.values().captures, 1, 'resume retry does not request a second microphone stream');
  assert.equal(s.service.getSnapshot().phase, 'recording');
  f.pcm(); await pump();
  assert.equal(f.sockets[0]!.sent.filter(item => item.type === 'input_audio_buffer.append').length, 1);
  s.service.cancel();
  assert.equal(s.leases(), 0);
  assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
  s.service.dispose();
});
test('running contexts do not resume twice and cancelled late grants cannot re-activate audio', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture();
    let resumes = 0;
    f.context.state = cancelled ? 'suspended' : 'running';
    f.context.resume = () => {
      resumes++;
      return cancelled ? new Promise(() => {}) : Promise.resolve();
    };
    const controller = new AbortController();
    const starting = f.prepare(controller.signal).start(async () => credential());
    const outcome = cancelled ? assert.rejects(starting, { name: 'AbortError' }) : starting;
    if (cancelled) controller.abort();
    f.grant(f.stream);
    await outcome;
    assert.equal(resumes, 1);
    if (!cancelled) (await starting).cancel();
    assert.equal(f.values().stops, 1);
    assert.equal(f.values().closes, 1);
  }
});
test('a failed post-permission resume releases hardware and the draft lease', async () => {
  const f = fixture(); const s = serviceFixture(f);
  f.context.state = 'suspended';
  let resumes = 0;
  f.context.resume = () => ++resumes === 1 ? new Promise(() => {}) : Promise.reject(new Error('Synthetic resume failure'));
  const start = s.service.start('hold'); f.grant(f.stream); await start;
  assert.equal(resumes, 2);
  assert.equal(s.service.getSnapshot().phase, 'retry');
  assert.equal(s.leases(), 0);
  assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
  s.service.dispose();
});
test('cancelling while the post-permission resume is pending cannot start a late processor', async () => {
  const f = fixture(); const s = serviceFixture(f);
  f.context.state = 'suspended';
  const resumes: (() => void)[] = [];
  f.context.resume = () => new Promise(resolve => { resumes.push(resolve); });
  let processors = 0;
  const createWorklet = f.env.createWorklet;
  f.env.createWorklet = context => { processors++; return createWorklet(context); };
  const starting = s.service.start('hold'); f.grant(f.stream); await turn();
  assert.equal(resumes.length, 2);
  assert.equal(s.service.getSnapshot().phase, 'permission');
  s.service.cancel(); await starting;
  for (const resolve of resumes) resolve();
  await turn();
  assert.equal(processors, 0);
  assert.equal(s.service.getSnapshot().phase, 'idle');
  assert.equal(s.leases(), 0);
  assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
  s.service.dispose();
});
test('cancelled permission grants stop tracks and cannot reopen the recording', async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = f.prepare(controller.signal).start(async () => credential());
  controller.abort(); f.grant(f.stream);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.values().stops, 1); assert.equal(f.values().closes, 1);
});
test('permission, resume, worklet, connection, tail, backpressure and final waits have bounded failure paths', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const stage of ['permission', 'resume', 'worklet', 'connection', 'tail', 'backpressure', 'final']) {
    const f = fixture(); const s = serviceFixture(f);
    if (stage === 'resume') {
      f.context.state = 'suspended';
      f.context.resume = () => new Promise(() => {});
    }
    if (stage === 'worklet') f.context.audioWorklet.addModule = () => new Promise(() => {});
    const original = f.env.openSocket;
    if (stage === 'connection') f.env.openSocket = url => { const socket = original(url); f.sockets.at(-1)!.autoConfig = false; return socket; };
    const start = s.service.start();
    if (stage !== 'permission') f.grant(f.stream);
    await turn();
    if (stage === 'permission' || stage === 'resume' || stage === 'worklet') {
      t.mock.timers.tick(30_001); await start;
    } else {
      await start; f.pcm();
      if (stage === 'tail') f.worklet.port.postMessage = () => {};
      if (stage === 'backpressure') f.sockets[0]!.bufferedAmount = 100_000;
      const stop = s.service.stop(); await turn();
      t.mock.timers.tick(20); await turn();
      t.mock.timers.tick(30_001); await turn();
      if (stage === 'final') { t.mock.timers.tick(90_001); await turn(); }
      await stop;
    }
    assert.equal(s.leases(), 0, stage); assert.equal(s.service.getSnapshot().phase, 'retry', stage);
    assert.equal(f.values().closes, 1, stage); s.service.dispose();
  }
});
test('provider errors, wrong/oversized/empty results and mismatched effective prompts cannot write a result', async () => {
  for (const cause of ['rate-limit', 'wrong-item', 'empty', 'oversized', 'prompt']) {
    const f = fixture(); const recording = await f.start(); f.pcm();
    const stop = recording.stop(); const rejected = assert.rejects(stop); await pump();
    const socket = f.sockets[0]!;
    if (cause === 'rate-limit') socket.emit('conversation.item.input_audio_transcription.failed', { error: { code: 'RateLimitReached' } });
    if (cause === 'wrong-item') { socket.commit(); socket.final('text', 'other'); }
    if (cause === 'empty') socket.final(' ');
    if (cause === 'oversized') socket.final('x'.repeat(MAX_TEXT_POINTS + 1));
    if (cause === 'prompt') socket.emit('session.updated', { session: {} });
    await rejected; assert.equal(socket.closed, 1); recording.cancel();
  }
});
test('audio encoder resamples across render blocks, emits PCM16LE, flushes tails and caps at 120 seconds', () => {
  for (const rate of [16000, 24000, 44100, 48000]) {
    const buffers: ArrayBuffer[] = [];
    const encoder = new PcmEncoder(rate, data => buffers.push(data));
    for (let i = 0; i < rate; i += 128) encoder.push(new Float32Array(Math.min(128, rate - i)).fill(0.5));
    encoder.flush();
    const bytes = Buffer.concat(buffers.map(b => Buffer.from(b)));
    assert.ok(Math.abs(bytes.length / 2 - 24000) <= 1);
    assert.equal(bytes.readInt16LE(0), 16384);
  }
  let samples = 0;
  const encoder = new PcmEncoder(24000, buffer => { samples += buffer.byteLength / 2; });
  for (let i = 0; i < MAX_SECONDS + 1; i++) encoder.push(new Float32Array(24000));
  encoder.flush(); assert.equal(samples, PCM_LIMIT); assert.equal(encoder.full, true);
});
