import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { startRecording } from './recorder.ts';
import type { AudioEnvironment } from './recorder.ts';
import { validateWav } from '../shared/wav.ts';
import { MAX_SAMPLES } from '../shared/limits.ts';

function fixture() {
  let stops = 0, closes = 0, portClosed = 0, disconnects = 0;
  const track = { stop: () => { stops++; }, onended: null as (() => void) | null };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  let grant!: (value: MediaStream) => void;
  const permission = new Promise<MediaStream>(resolve => { grant = resolve; });
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (_message: unknown) => {},
    close: () => { portClosed++; },
  };
  const node = { port, connect() {}, disconnect: () => { disconnects++; }, onprocessorerror: null as (() => void) | null };
  const context = {
    sampleRate: 16000, audioWorklet: { addModule: async (url: string) => assert.match(url, /pcm-worklet\.js$/) },
    resume: async () => {}, close: async () => { closes++; }, state: 'running', onstatechange: null,
    createMediaStreamSource: () => ({ connect() {}, disconnect: () => { disconnects++; } }), destination: {},
  };
  const env: AudioEnvironment = {
    secure: true, createContext: () => context as unknown as AudioContext,
    getUserMedia: () => permission, createNode: () => node as unknown as AudioWorkletNode,
  };
  return { env, node, port, context, track, stream, grant, values: () => ({ stops, closes, portClosed, disconnects }) };
}
test('native capture releases AudioContext immediately and stops a permission grant arriving after cancel', async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = startRecording(controller.signal, () => assert.fail('unexpected failure'), f.env);
  controller.abort();
  assert.equal(f.values().closes, 1);
  f.grant(f.stream);
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.values().stops, 1);
});
test('capture finalizes WAV from transferred PCM, stops tracks and closes all resources', async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = startRecording(controller.signal, () => assert.fail('unexpected failure'), f.env);
  f.grant(f.stream);
  const recorder = await pending;
  f.port.onmessage!({ data: { type: 'chunk', samples: new Float32Array([0.2, -0.2]) } });
  f.port.postMessage = message => {
    assert.equal(message, 'stop');
    f.port.onmessage!({ data: { type: 'done' } });
  };
  validateWav(await recorder.stop());
  assert.equal(f.values().closes, 1);
  assert.equal(f.values().portClosed, 1);
  assert.equal(f.values().disconnects, 2);
  assert.ok(f.values().stops >= 1);
  recorder.cancel(); controller.abort();
  assert.equal(f.values().closes, 1);
});
test('unsupported rate, insecure context, processor error and hard limit are explicit failures', async () => {
  const rate = fixture(); rate.context.sampleRate = 48000;
  await assert.rejects(startRecording(new AbortController().signal, () => {}, rate.env), /16 kHz/);
  assert.equal(rate.values().closes, 1);
  await assert.rejects(startRecording(new AbortController().signal, () => {}, { ...fixture().env, secure: false }), /HTTPS/);
  for (const cause of ['processor', 'limit'] as const) {
    const f = fixture(); const errors: Error[] = [];
    const pending = startRecording(new AbortController().signal, error => errors.push(error), f.env);
    f.grant(f.stream); await pending;
    if (cause === 'processor') f.node.onprocessorerror!();
    else f.port.onmessage!({ data: { type: 'limit' } });
    assert.equal(errors.length, 1); assert.equal(f.values().closes, 1); assert.equal(f.values().stops, 1);
  }
});
test('synchronous setup failures still handle rejected resume promises and release late permission grants', async () => {
  const unavailable = fixture();
  unavailable.context.resume = async () => { throw new Error('private resume error'); };
  unavailable.env.getUserMedia = () => { throw new Error('private unsupported API error'); };
  await assert.rejects(startRecording(new AbortController().signal, () => {}, unavailable.env), /Microphone access failed/);
  assert.equal(unavailable.values().closes, 1);
  const worklet = fixture();
  worklet.context.audioWorklet.addModule = () => { throw new Error('private worklet error'); };
  await assert.rejects(startRecording(new AbortController().signal, () => {}, worklet.env), /Microphone access failed/);
  worklet.grant(worklet.stream);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(worklet.values().closes, 1);
  assert.equal(worklet.values().stops, 1);
});
test('actual AudioWorklet downmixes, flushes a partial chunk, and refuses silent truncation', async () => {
  const source = await readFile(new URL('./pcm-worklet.js', import.meta.url), 'utf8');
  const events: { type: string; samples?: Float32Array }[] = [];
  let Processor!: new () => {
    port: { onmessage: (event: { data: string }) => void };
    process(inputs: Float32Array[][]): boolean;
  };
  runInNewContext(source, {
    Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (value: { type: string; samples?: Float32Array }) => events.push(value), onmessage: null };
    },
    registerProcessor: (name: string, value: typeof Processor) => { assert.equal(name, 'cockpit-speech-pcm'); Processor = value; },
  });
  const processor = new Processor();
  processor.process([[new Float32Array([1, 0]), new Float32Array([-1, 1])]]);
  processor.port.onmessage({ data: 'stop' });
  assert.deepEqual(Array.from(events[0]!.samples!), [0, 0.5]);
  assert.equal(events[1]!.type, 'done');
  assert.equal(processor.process([]), false);
  const limited = new Processor();
  assert.equal(limited.process([[new Float32Array(MAX_SAMPLES + 1)]]), false);
  assert.equal(events.at(-1)!.type, 'limit');
});
