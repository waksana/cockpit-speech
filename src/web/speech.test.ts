import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatWindowSnapshot, DraftPurpose, HostSnapshot, ModuleDraft, ModuleDraftSnapshot } from '@cockpit/module-api';
import { SpeechError } from '../shared/limits.ts';
import { SpeechService } from './speech.ts';
import type { Recording } from './recorder.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function store<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set: (value: T) => { state = value; for (const fn of listeners) fn(); },
    listeners,
  };
}
function draft(id = 'draft-1', purpose: DraftPurpose = { kind: 'prompt' }): ModuleDraft & { state: ReturnType<typeof store<ModuleDraftSnapshot>> } {
  const state = store<ModuleDraftSnapshot>({ text: 'hello world', revision: 1, blocks: [], pending: false, unconfirmed: false, hasContent: true });
  return {
    id, sessionId: 's', purpose, ...state, state,
    editText(text) { state.set({ ...state.getSnapshot(), text, revision: state.getSnapshot().revision + 1 }); },
    block(reason) {
      const block = { id: 'speech-lease', reason };
      state.set({ ...state.getSnapshot(), blocks: [...state.getSnapshot().blocks, block] });
      let done = false;
      return () => {
        if (done) return; done = true;
        state.set({ ...state.getSnapshot(), blocks: state.getSnapshot().blocks.filter(item => item !== block) });
      };
    },
  };
}
function fixture(options: { permission?: boolean; purpose?: DraftPurpose; ready?: (signal: AbortSignal) => Promise<void> } = {}) {
  const host = store<HostSnapshot>({ sessionId: 's', visible: true, connected: true });
  const chatWindow = store<ChatWindowSnapshot>({
    sessionId: 's', status: 'ready', hasMore: false, partial: false,
    messages: [{ id: 'ui', origin: { sessionId: 's', messageId: 'native' }, role: 'assistant', text: 'initial context', complete: true, children: [] }],
  });
  const permission = deferred<Recording>();
  const result = deferred<string>();
  const controller = new AbortController();
  const original = draft('draft-1', options.purpose);
  const reports: Error[] = [];
  let cancelled = 0;
  let stops = 0;
  let requests = 0;
  let captures = 0;
  let preparationsCancelled = 0;
  let readyCalls = 0;
  let limitReached!: () => void;
  let capturedContext: string | undefined;
  let capturedSignal: AbortSignal | undefined;
  let recorderFailure!: (error: SpeechError) => void;
  const recording: Recording = {
    stop: async () => { stops++; return new Uint8Array([1]); },
    cancel: () => { cancelled++; },
  };
  const service = new SpeechService({
    signal: controller.signal, host, chatWindow,
    prepare: (_signal, fail, limit) => {
      recorderFailure = fail; limitReached = limit;
      return {
        start: async () => { captures++; return options.permission ? permission.promise : recording; },
        cancel: () => { preparationsCancelled++; },
      };
    },
    ready: async signal => { readyCalls++; await options.ready?.(signal); },
    transcribe: async (_audio, context, signal) => { requests++; capturedContext = context; capturedSignal = signal; return result.promise; },
    report: error => reports.push(error),
  });
  service.setTarget({ draft: original, disabled: false, sendBlocked: false, selection: () => ({ start: 6, end: 11 }) });
  return { service, host, chatWindow, original, permission, result, controller, reports, recording,
    values: () => ({ cancelled, stops, requests, captures, preparationsCancelled, readyCalls, capturedContext, capturedSignal }),
    limit: () => limitReached(), fail: (e: SpeechError) => recorderFailure(e) };
}
test('prompt, ask and plan insert at the captured selection only after stop; context is captured once', async t => {
  for (const purpose of [{ kind: 'prompt' }, { kind: 'ask', requestId: 'a' }, { kind: 'plan', requestId: 'p' }] as const) {
    const f = fixture({ purpose }); t.after(() => f.service.dispose());
    await f.service.start();
    assert.equal(f.original.getSnapshot().text, 'hello world');
    assert.equal(f.original.getSnapshot().blocks.length, 1);
    assert.equal(f.values().requests, 0);
    f.chatWindow.set({ ...f.chatWindow.getSnapshot(), messages: [] });
    const stopped = f.service.stop();
    await Promise.resolve();
    assert.equal(f.service.getSnapshot().phase, 'transcribing');
    f.result.resolve('speech');
    await stopped;
    assert.equal(f.original.getSnapshot().text, 'hello speech');
    assert.equal(f.original.getSnapshot().blocks.length, 0);
    assert.equal(f.values().capturedContext, 'initial context');
    assert.equal(f.service.getSnapshot().recovery, null);
  }
});
test('manual revisions win and successful text remains recoverable; explicit insertion preserves selection', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  f.original.editText('manual words');
  const stop = f.service.stop(); f.result.resolve('recognized');
  await stop;
  assert.equal(f.original.getSnapshot().text, 'manual words');
  assert.equal(f.service.getSnapshot().recovery?.text, 'recognized');
  assert.equal(f.service.canStart(), false);
  assert.equal(f.service.canInsert(), true);
  f.service.insertRecovery();
  assert.equal(f.original.getSnapshot().text, 'manualrecognized words');
  assert.equal(f.service.getSnapshot().recovery, null);
});
test('a recovered result never redirects to another draft, including reused native request IDs', async t => {
  const f = fixture({ purpose: { kind: 'ask', requestId: 'reused' } }); t.after(() => f.service.dispose());
  await f.service.start(); f.original.editText('manual');
  const stopped = f.service.stop(); f.result.resolve('recognized'); await stopped;
  const replacement = draft('different-lifetime', { kind: 'ask', requestId: 'reused' });
  f.service.setTarget({ draft: replacement, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  assert.equal(f.service.canInsert(), false);
  f.service.insertRecovery();
  assert.equal(replacement.getSnapshot().text, 'hello world');
  assert.equal(f.service.getSnapshot().recovery?.text, 'recognized');
});
test('permission late grants are cancelled after input loss or module abort, with immediate lease release', async t => {
  for (const cause of ['unmount', 'navigation', 'abort', 'no-free-text', 'replacement'] as const) {
    const f = fixture({ permission: true }); t.after(() => f.service.dispose());
    const starting = f.service.start();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.service.getSnapshot().phase, 'permission');
    if (cause === 'unmount') f.service.clearTarget(f.original.id);
    if (cause === 'navigation') f.host.set({ ...f.host.getSnapshot(), sessionId: 'other' });
    if (cause === 'abort') f.controller.abort();
    if (cause === 'no-free-text') f.service.setTarget({ draft: f.original, disabled: false, sendBlocked: true, selection: () => ({ start: 0, end: 0 }) });
    if (cause === 'replacement') f.service.setTarget({ draft: draft('replacement'), disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
    assert.equal(f.original.getSnapshot().blocks.length, 0, cause);
    f.permission.resolve(f.recording); await starting;
    assert.equal(f.values().cancelled, 1, cause);
    assert.equal(f.values().requests, 0, cause);
    assert.equal(f.service.getSnapshot().phase, 'idle', cause);
  }
});
test('cancelled HTTP completion never writes to the original or replacement draft', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  const stop = f.service.stop(); await Promise.resolve();
  f.service.cancel();
  assert.equal(f.values().capturedSignal?.aborted, true);
  f.result.resolve('late response'); await stop;
  assert.equal(f.original.getSnapshot().text, 'hello world');
  assert.equal(f.service.getSnapshot().recovery, null);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
});
test('recorder and HTTP failures release leases and report one safe visible error', async t => {
  for (const failure of ['recorder', 'http']) {
    const f = fixture(); t.after(() => f.service.dispose());
    await f.service.start();
    if (failure === 'recorder') f.fail(new SpeechError('AUDIO_LIMIT', 'Recording limit reached.'));
    else {
      const stop = f.service.stop(); f.result.reject(new Error('PRIVATE-DETAIL')); await stop;
    }
    assert.equal(f.original.getSnapshot().blocks.length, 0);
    assert.equal(f.service.getSnapshot().phase, 'idle');
    assert.ok(f.service.getSnapshot().error);
    assert.equal(f.reports.length, failure === 'http' ? 1 : 0, 'known errors are shown inline without a duplicate global alert');
    assert.doesNotMatch(f.service.getSnapshot().error!, /PRIVATE/);
  }
});

test('configuration readiness gates capture, retries explicitly, and preserves click-time draft identity', async t => {
  let configured = false;
  const f = fixture({ ready: async () => {
    if (!configured) throw new SpeechError('CONFIG_UNAVAILABLE', '请创建 azure-speech.json。');
  } });
  t.after(() => f.service.dispose());
  await f.service.start();
  assert.match(f.service.getSnapshot().error!, /azure-speech\.json/);
  assert.equal(f.values().captures, 0);
  assert.equal(f.values().requests, 0);
  assert.equal(f.values().preparationsCancelled, 1);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  configured = true;
  await f.service.start();
  assert.equal(f.values().readyCalls, 2);
  assert.equal(f.values().captures, 1);
  assert.equal(f.service.getSnapshot().phase, 'recording');
});

test('cancellation during readiness never acquires the microphone, even if readiness completes late', async t => {
  const ready = deferred<void>();
  let signal!: AbortSignal;
  const f = fixture({ ready: value => { signal = value; return ready.promise; } });
  t.after(() => f.service.dispose());
  const starting = f.service.start();
  assert.equal(f.service.getSnapshot().phase, 'checking');
  f.service.cancel();
  assert.equal(signal.aborted, true);
  ready.resolve();
  await starting;
  assert.equal(f.values().captures, 0);
  assert.equal(f.values().requests, 0);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
});

test('reaching the recording limit automatically transcribes once without native submission or lost audio', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.start();
  f.limit();
  f.limit();
  await f.service.stop();
  f.result.resolve('bounded speech');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.values().stops, 1);
  assert.equal(f.values().requests, 1);
  assert.equal(f.original.getSnapshot().text, 'hello bounded speech');
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  assert.equal(f.service.getSnapshot().phase, 'idle');
  assert.match(f.service.getSnapshot().notice!, /两分钟/);
});
test('pending, unconfirmed, peer blocks and free-text gates prevent capture and recovery insertion', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  for (const patch of [{ pending: true }, { unconfirmed: true }, { blocks: [{ id: 'peer', reason: 'peer' }] }]) {
    const before = f.original.getSnapshot();
    f.original.state.set({ ...before, ...patch });
    assert.equal(f.service.canStart(), false); await f.service.start();
    assert.equal(f.service.getSnapshot().phase, 'idle');
    f.original.state.set(before);
  }
  f.service.setTarget({ draft: f.original, disabled: false, sendBlocked: true, selection: () => ({ start: 0, end: 0 }) });
  assert.equal(f.service.canStart(), false);
});
test('double stop sends once; peer block appearing during transcription retains text', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  const stop = f.service.stop(); await f.service.stop();
  f.original.state.set({ ...f.original.getSnapshot(), blocks: [...f.original.getSnapshot().blocks, { id: 'peer', reason: 'wait' }] });
  f.result.resolve('recognized'); await stop;
  assert.equal(f.values().requests, 1); assert.equal(f.values().stops, 1);
  assert.equal(f.original.getSnapshot().text, 'hello world');
  assert.equal(f.service.getSnapshot().recovery?.text, 'recognized');
  assert.equal(f.service.canInsert(), false);
  assert.deepEqual(f.original.getSnapshot().blocks.map(x => x.id), ['peer']);
});
