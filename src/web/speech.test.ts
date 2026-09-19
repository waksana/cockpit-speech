import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatWindowSnapshot, DraftPurpose, HostSnapshot, ModuleDraft, ModuleDraftSnapshot } from '@cockpit/module-api';
import { SpeechError } from '../shared/limits.ts';
import { SpeechService } from './speech.ts';
import type { Recording } from './recorder.ts';
import { HOLD_DELAY, HoldGesture } from './hold.ts';

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
  const state = store<ModuleDraftSnapshot>({ text: 'hello world', revision: 1, blocks: [], pending: false, unconfirmed: false, hasContent: true, retired: false });
  return {
    id, sessionId: 's', purpose, ...state, state,
    editText(text) { state.set({ ...state.getSnapshot(), text, revision: state.getSnapshot().revision + 1 }); },
    editTextIfRevision(text, revision) {
      const snapshot = state.getSnapshot();
      if (snapshot.retired) throw new Error('retired');
      if (snapshot.revision !== revision || snapshot.pending || snapshot.unconfirmed || snapshot.blocks.length) return false;
      this.editText(text);
      return true;
    },
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
  const retryResult = deferred<string>();
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
  let ready: Promise<void> = Promise.resolve();
  let readinessError: unknown;
  let retryable = true;
  const levels: ((value: number, seconds: number) => void)[] = [];
  const recording: Recording = {
    stop: async committed => { stops++; await ready; if (readinessError) throw readinessError; requests++; committed?.(); return result.promise; },
    retry: async committed => { requests++; committed?.(); return retryResult.promise; },
    retryable: () => retryable,
    cancel: () => { cancelled++; },
  };
  const service = new SpeechService({
    signal: controller.signal, host, chatWindow,
    prepare: (signal, fail, limit) => {
      capturedSignal = signal;
      recorderFailure = fail; limitReached = limit;
      return {
        start: async (session, context, recordingOptions) => {
          if (recordingOptions?.onLevel) levels.push(recordingOptions.onLevel);
          captures++; capturedContext = context;
          ready = session(signal).then(() => {}, error => { readinessError = error; });
          return options.permission ? permission.promise : recording;
        },
        cancel: () => { preparationsCancelled++; },
      };
    },
    session: async signal => {
      readyCalls++;
      await options.ready?.(signal);
      return { clientSecret: 'ephemeral-fixture', expiresAt: 2_000_000_000,
        socketUrl: 'wss://synthetic.openai.azure.com/openai/v1/realtime?intent=transcription', deployment: 'dictation' };
    },
    report: error => reports.push(error),
  });
  service.setTarget({ draft: original, disabled: false, sendBlocked: false, selection: () => ({ start: 6, end: 11 }) });
  return { service, host, chatWindow, original, permission, result, retryResult, controller, reports, recording,
    setRetryable: (value: boolean) => { retryable = value; },
    values: () => ({ cancelled, stops, requests, captures, preparationsCancelled, readyCalls, capturedContext, capturedSignal }),
    limit: () => limitReached(), fail: (e: SpeechError) => recorderFailure(e),
    level: (value: number, index = levels.length - 1, seconds = 12.5) => levels[index]!(value, seconds) };
}
test('elapsed time follows captured samples and clear resets retained operations without changing drafts', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  f.service.setPressing(f.original.id, true);
  assert.equal(f.service.getSnapshot().pressing, true);
  await f.service.start('hold');
  f.level(0.2, 0, 7.9);
  assert.equal(f.service.getSnapshot().elapsedSeconds, 7);
  f.limit();
  f.level(0.5, 0, 121);
  assert.equal(f.service.getSnapshot().elapsedSeconds, 120);
  assert.equal(f.service.getSnapshot().level, 0);
  f.service.clear();
  assert.equal(f.service.getSnapshot().phase, 'idle');
  assert.equal(f.service.getSnapshot().elapsedSeconds, 0);
  assert.equal(f.service.getSnapshot().pressing, false);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  assert.equal(f.original.getSnapshot().text, 'hello world');
  f.level(0.5, 0, 19);
  assert.equal(f.service.getSnapshot().elapsedSeconds, 0);
});
test('clear cancels retries and ignores late results, including failed startup without retained audio', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  const stopped = f.service.stop();
  f.result.reject(new SpeechError('SPEECH_FAILED', 'synthetic failure'));
  await stopped;
  assert.equal(f.service.hasRetainedRecording(), true);
  const retry = f.service.retry();
  f.service.clear();
  f.retryResult.resolve('late transcript'); await retry;
  assert.equal(f.service.getSnapshot().phase, 'idle');
  assert.equal(f.service.hasRetainedRecording(), false);
  assert.equal(f.service.getSnapshot().recovery, null);
  assert.equal(f.original.getSnapshot().text, 'hello world');
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  const denied = fixture({ permission: true }); t.after(() => denied.service.dispose());
  const start = denied.service.start();
  denied.setRetryable(false);
  denied.permission.reject(new SpeechError('PERMISSION_DENIED', 'synthetic denial')); await start;
  assert.equal(denied.service.getSnapshot().phase, 'retry');
  denied.service.clear();
  assert.equal(denied.service.getSnapshot().phase, 'idle');
  assert.equal(denied.service.canStart(), true);
});
test('hold and button recordings publish live levels, resetting on stop and ignoring older callbacks', async t => {
  for (const mode of ['hold', 'button'] as const) {
    const f = fixture(); t.after(() => f.service.dispose());
    await f.service.start(mode);
    f.level(0.25);
    assert.equal(f.service.getSnapshot().level, 0.25);
    f.service.cancel();
    f.level(0.9);
    assert.equal(f.service.getSnapshot().level, 0);
    await f.service.start(mode);
    f.level(0.8, 0);
    assert.equal(f.service.getSnapshot().level, 0);
    f.level(0.5);
    const stopped = f.service.stop();
    f.level(0.9);
    assert.equal(f.service.getSnapshot().level, 0);
    f.result.resolve('spoken'); await stopped;
    assert.equal(f.service.getSnapshot().level, 0);
  }
});
test('prompt, ask and plan insert at the captured selection only after stop; context is captured once', async t => {
  for (const purpose of [{ kind: 'prompt' }, { kind: 'ask', requestId: 'a' }, { kind: 'plan', requestId: 'p' }] as const) {
    const f = fixture({ purpose }); t.after(() => f.service.dispose());
    await f.service.start();
    assert.equal(f.original.getSnapshot().text, 'hello world');
    assert.equal(f.original.getSnapshot().blocks.length, 1);
    assert.equal(f.values().requests, 0);
    f.chatWindow.set({ ...f.chatWindow.getSnapshot(), messages: [] });
    const stopped = f.service.stop();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.service.getSnapshot().phase, 'transcribing');
    f.result.resolve('speech');
    await stopped;
    assert.equal(f.original.getSnapshot().text, 'hello speech');
    assert.equal(f.original.getSnapshot().blocks.length, 0);
    assert.equal(f.values().capturedContext, 'initial context');
    assert.equal(f.service.getSnapshot().recovery, null);
    assert.deepEqual(f.service.getSnapshot().focus, {
      id: f.original.id, revision: f.original.getSnapshot().revision, selection: { start: 12, end: 12 },
    });
  }
});
test('manual revisions win and successful text remains recoverable; explicit insertion preserves selection', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  f.original.editText('manual words');
  const stop = f.service.stop(); f.result.resolve('recognized');
  await stop;
  assert.equal(f.original.getSnapshot().text, 'manual words');
  assert.equal(f.service.getSnapshot(f.original.id).recovery?.text, 'recognized');
  assert.equal(f.service.canStart(), false);
  assert.equal(f.service.canInsert(), true);
  f.service.insertRecovery();
  assert.equal(f.original.getSnapshot().text, 'manualrecognized words');
  assert.equal(f.service.getSnapshot().recovery, null);
  assert.deepEqual(f.service.getSnapshot().focus?.selection, { start: 16, end: 16 });
});
test('a recovered result never redirects to another draft, including reused native request IDs', async t => {
  const f = fixture({ purpose: { kind: 'ask', requestId: 'reused' } }); t.after(() => f.service.dispose());
  await f.service.start(); f.original.editText('manual');
  const stopped = f.service.stop(); f.result.resolve('recognized'); await stopped;
  f.service.clearTarget(f.original.id);
  assert.equal(f.service.getSnapshot().focus, null);
  assert.equal(f.service.getSnapshot(f.original.id).recovery?.text, 'recognized');
  const replacement = draft('different-lifetime', { kind: 'ask', requestId: 'reused' });
  f.service.setTarget({ draft: replacement, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  assert.equal(f.service.canInsert(), false);
  f.service.insertRecovery();
  assert.equal(replacement.getSnapshot().text, 'hello world');
  assert.equal(f.service.getSnapshot(f.original.id).recovery?.text, 'recognized');
});
test('successful insertion never adds a notice above the editor', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.start();
  const stopped = f.service.stop();
  f.result.resolve('recognized');
  await stopped;
  assert.equal(f.service.getSnapshot().notice, null);
  f.service.clearTarget('unrelated');
  assert.equal(f.service.getSnapshot().notice, null);
  f.service.clearTarget(f.original.id);
  const answer = draft('answer', { kind: 'ask', requestId: 'new-question' });
  f.service.setTarget({ draft: answer, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  assert.equal(f.service.getSnapshot().notice, null);
  assert.equal(answer.getSnapshot().text, 'hello world');
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
test('cancelled transcription completion never writes to the original or replacement draft', async t => {
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
test('hold release or upward swipe during permission cancels the lease and every late recording', async t => {
  for (const release of [true, false]) {
    await t.test(release ? 'release before ready' : 'exit before ready', async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture({ permission: true });
      t.after(() => f.service.dispose());
      f.original.editText('');
      const gesture = new HoldGesture({
        allowed: () => f.service.canStart(), bounds: () => ({ left: 0, top: 0, right: 100, bottom: 40 }),
        phase: () => f.service.getSnapshot().phase,
        start: () => { void f.service.start(); }, stop: () => { void f.service.stop(); },
        cancel: () => f.service.cancel(), focus: () => assert.fail('must not focus on long hold'),
        interrupt: () => f.service.interrupt(),
      });
      const point = { pointerId: 1, clientX: 20, clientY: 20, button: 0, isPrimary: true };
      gesture.down(point, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
      t.mock.timers.tick(HOLD_DELAY);
      assert.equal(f.service.getSnapshot().phase, 'permission');
      if (release) gesture.up(point);
      else gesture.move({ ...point, clientY: -50 });
      assert.equal(f.original.getSnapshot().blocks.length, 0);
      assert.equal(f.values().capturedSignal?.aborted, true);
      f.permission.resolve(f.recording);
      await new Promise<void>(resolve => setImmediate(resolve));
      gesture.move(point); gesture.up(point);
      assert.equal(f.values().cancelled, 1);
      assert.equal(f.values().stops, 0);
      assert.equal(f.values().requests, 0);
      assert.equal(f.service.getSnapshot().phase, 'idle');
      assert.equal(f.service.canRetry(), false);
      assert.equal(f.original.getSnapshot().text, '');
    });
  }
});
test('failures release leases, retain replay data and expose only a safe retry-button error', async t => {
  for (const failure of ['recorder', 'http']) {
    const f = fixture(); t.after(() => f.service.dispose());
    await f.service.start();
    if (failure === 'recorder') f.fail(new SpeechError('AUDIO_LIMIT', 'Recording limit reached.'));
    else {
      const stop = f.service.stop(); f.result.reject(new Error('PRIVATE-DETAIL')); await stop;
    }
    assert.equal(f.original.getSnapshot().blocks.length, 0);
    assert.equal(f.service.getSnapshot().phase, 'retry');
    assert.ok(f.service.getSnapshot().error);
    assert.equal(f.reports.length, 0, 'no global error notification');
    assert.doesNotMatch(f.service.getSnapshot().error!, /PRIVATE/);
  }
});

test('credential failure never delays local capture and retains the original recording for explicit retry', async t => {
  let configured = false;
  const f = fixture({ ready: async () => {
    if (!configured) throw new SpeechError('CONFIG_UNAVAILABLE', '请创建 azure-openai.json。');
  } });
  t.after(() => f.service.dispose());
  await f.service.start();
  assert.equal(f.service.getSnapshot().phase, 'recording');
  await f.service.stop();
  assert.match(f.service.getSnapshot().error!, /azure-openai\.json/);
  assert.equal(f.values().captures, 1);
  assert.equal(f.values().requests, 0);
  assert.equal(f.values().preparationsCancelled, 0);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  configured = true;
  const retry = f.service.retry(); f.retryResult.resolve('replayed'); await retry;
  assert.equal(f.values().captures, 1);
  assert.equal(f.service.getSnapshot().phase, 'idle');
  assert.equal(f.original.getSnapshot().text, 'hello replayed');
});

test('cancellation while credentials are pending stops local capture and ignores late readiness', async t => {
  const ready = deferred<void>();
  let signal!: AbortSignal;
  const f = fixture({ ready: value => { signal = value; return ready.promise; } });
  t.after(() => f.service.dispose());
  const starting = f.service.start();
  assert.equal(f.service.getSnapshot().phase, 'permission');
  f.service.cancel();
  assert.equal(signal.aborted, true);
  ready.resolve();
  await starting;
  assert.equal(f.values().captures, 1);
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
  assert.equal(f.service.getSnapshot().notice, null);
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
test('held limit waits for release, keeps its lease and can still be cancelled without text or retry', async t => {
  for (const action of ['release', 'exit']) {
    const f = fixture(); t.after(() => f.service.dispose());
    await f.service.start('hold');
    f.limit(); f.limit();
    assert.equal(f.service.getSnapshot().phase, 'recording');
    assert.equal(f.service.getSnapshot().holdingAtLimit, true);
    assert.equal(f.original.getSnapshot().blocks.length, 1);
    assert.equal(f.values().stops, 0);
    if (action === 'release') {
      const stop = f.service.stop(); f.result.resolve('capped speech'); await stop;
      assert.equal(f.original.getSnapshot().text, 'hello capped speech');
    } else {
      f.service.cancel();
      assert.equal(f.values().requests, 0);
      assert.equal(f.service.canRetry(), false);
      assert.equal(f.original.getSnapshot().text, 'hello world');
    }
    assert.equal(f.service.getSnapshot().holdingAtLimit, false);
    assert.equal(f.original.getSnapshot().blocks.length, 0);
  }
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

test('retry preserves original revision/context, ignores superseded completions and releases every lease', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  const old = f.service.stop();
  await turn();
  f.fail(new SpeechError('NETWORK', 'Disconnected'));
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  f.original.editText('manual correction');
  f.chatWindow.set({ ...f.chatWindow.getSnapshot(), messages: [] });
  const retry = f.service.retry();
  assert.equal(f.original.getSnapshot().blocks.length, 1);
  f.result.resolve('stale first result'); await old;
  assert.equal(f.service.getSnapshot().recovery, null);
  f.retryResult.resolve('retained recording'); await retry;
  assert.equal(f.values().captures, 1);
  assert.equal(f.values().capturedContext, 'initial context');
  assert.equal(f.original.getSnapshot().text, 'manual correction');
  assert.equal(f.service.getSnapshot().recovery?.text, 'retained recording');
  assert.equal(f.original.getSnapshot().blocks.length, 0);
});
test('target replacement hides retained audio without discarding or redirecting it', async t => {
  const f = fixture({ purpose: { kind: 'ask', requestId: 'reused' } }); t.after(() => f.service.dispose());
  await f.service.start(); f.fail(new SpeechError('NETWORK', 'Disconnected'));
  assert.equal(f.service.canRetry(), true);
  f.service.setTarget({ draft: draft('new-lifetime', { kind: 'ask', requestId: 'reused' }),
    disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  assert.equal(f.service.canRetry(), false);
  assert.equal(f.values().cancelled, 0);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  assert.equal(f.service.getSnapshot(f.original.id).phase, 'retry');
});
test('an explicit too-short failure discards the unusable take like cancellation', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); f.setRetryable(false);
  f.fail(new SpeechError('AUDIO_TOO_SHORT', 'Too short'));
  assert.equal(f.service.getSnapshot().phase, 'idle');
  assert.equal(f.service.hasRetainedRecording(), false);
  assert.equal(f.service.canRetry(), false);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
  await f.service.start();
  assert.equal(f.values().captures, 2);
  assert.equal(f.service.getSnapshot().phase, 'recording');
});
test('an unreplayable device failure is not mistaken for a too-short cancellation', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); f.setRetryable(false);
  f.fail(new SpeechError('AUDIO_FAILED', 'Synthetic device failure'));
  assert.equal(f.service.getSnapshot().phase, 'retry');
  assert.equal(f.service.hasRetainedRecording(), true);
  assert.equal(f.service.canRetry(), false);
  await f.service.retry();
  assert.equal(f.values().captures, 1);
  assert.equal(f.values().cancelled, 0);
  f.service.clear();
  assert.equal(f.values().cancelled, 1);
  assert.equal(f.service.canStart(), true);
});

function turn() { return new Promise<void>(resolve => setImmediate(resolve)); }
