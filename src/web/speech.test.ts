import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatWindowSnapshot, DraftPurpose, HostSnapshot, ModuleDraft, ModuleDraftSnapshot } from '@waksana/cockpit-module-sdk/frontend';
import { SpeechError } from '../shared/limits.ts';
import { SpeechService } from './speech.ts';
import type { Recording } from './recorder.ts';
import { HOLD_DELAY, HoldGesture } from './hold.ts';
import { protectSpeechUnload } from './frontend.ts';

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
  const state = store<ModuleDraftSnapshot>({ text: 'hello world', revision: 1, blocks: [], pending: false, unconfirmed: false, hasContent: true, retired: false,
    ...(purpose.kind === 'ask' ? { askContext: { question: 'Synthetic question?', choices: ['Alpha', 'Beta'] } } : {}) });
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
    captureSend: () => assert.fail('Draft-only lifecycle must not capture send permission'),
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
  const texts: ((value: string) => void)[] = [];
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
          if (recordingOptions?.onText) texts.push(recordingOptions.onText);
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
    level: (value: number, index = levels.length - 1, seconds = 12.5) => levels[index]!(value, seconds),
    text: (value: string, index = texts.length - 1) => texts[index]!(value) };
}
test('unload protection includes hidden recording, retry and recovery without draft blockers', async t => {
  for (const phase of ['permission', 'recording', 'transcribing', 'retry', 'recovery'] as const) {
    await t.test(phase, async t => {
      const f = fixture({ permission: phase === 'permission' });
      t.after(() => f.service.dispose());
      const target = new EventTarget();
      t.after(protectSpeechUnload(f.service, target));
      const unload = () => {
        const event = new Event('beforeunload', { cancelable: true });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      assert.equal(unload(), false, 'ordinary persisted draft text needs no module warning');
      const start = f.service.start();
      if (phase !== 'permission') await start;
      if (phase === 'transcribing') void f.service.stop();
      if (phase === 'retry') f.fail(new SpeechError('NETWORK_FAILED', 'Synthetic failure'));
      if (phase === 'recovery') {
        f.original.editText('external edit');
        const stop = f.service.stop(); f.result.resolve('retained result'); await stop;
      }
      assert.equal(unload(), true);
      f.service.clearTarget(f.original.id);
      const other = draft('other');
      f.service.setTarget({ draft: other, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
      if (phase === 'permission') {
        f.permission.resolve(f.recording); await start;
        assert.equal(unload(), false, 'departure cancels pending permission');
      } else {
        assert.equal(f.service.getSnapshot().phase, 'idle');
        assert.equal(unload(), true, 'hidden original draft still owns nonpersisted work');
        if (phase === 'retry' || phase === 'recovery') assert.equal(f.original.getSnapshot().blocks.length, 0);
        const counters = f.values();
        assert.equal(unload(), true);
        assert.deepEqual(f.values(), counters, 'beforeunload cannot stop, clear or retry');
        f.service.clear(f.original.id);
        assert.equal(unload(), false);
      }
    });
  }
});
test('startup error alone and successfully persisted text do not warn; retirement releases retained work', async t => {
  const failed = fixture({ permission: true }); t.after(() => failed.service.dispose());
  const starting = failed.service.start();
  failed.permission.reject(new SpeechError('MIC_FAILED', 'Synthetic permission failure'));
  await starting;
  assert.equal(failed.service.getSnapshot().phase, 'retry');
  assert.equal(failed.service.hasUnpersistedWork(), false);
  const completed = fixture(); t.after(() => completed.service.dispose());
  await completed.service.start();
  const stopping = completed.service.stop(); completed.result.resolve('saved'); await stopping;
  assert.equal(completed.service.hasUnpersistedWork(), false);
  const retained = fixture(); t.after(() => retained.service.dispose());
  await retained.service.start(); retained.fail(new SpeechError('NETWORK_FAILED', 'Synthetic failure'));
  retained.service.clearTarget(retained.original.id);
  assert.equal(retained.service.hasUnpersistedWork(), true);
  retained.original.state.set({ ...retained.original.getSnapshot(), retired: true });
  assert.equal(retained.service.hasUnpersistedWork(), false);
});
test('live snapshots replace the owned selection without focus; final completion confirms durable host insertion', async t => {
  for (const purpose of [{ kind: 'prompt' }, { kind: 'ask', requestId: 'a' }, { kind: 'plan', requestId: 'p' }] as const) {
    const f = fixture({ purpose }); t.after(() => f.service.dispose());
    await f.service.start('hold');
    f.text('C'); assert.equal(f.original.getSnapshot().text, 'hello C');
    assert.equal(f.service.ownsDraft(f.original.id), true);
    f.text('AC'); assert.equal(f.original.getSnapshot().text, 'hello AC');
    f.text('ABC'); assert.equal(f.original.getSnapshot().text, 'hello ABC');
    assert.equal(f.original.getSnapshot().blocks.length, 1);
    assert.equal(f.service.getSnapshot().phase, 'recording');
    assert.equal(f.service.getSnapshot().focus, null);
    const revision = f.original.getSnapshot().revision;
    f.text('ABC'); assert.equal(f.original.getSnapshot().revision, revision);
    const stopped = f.service.stop(); f.result.resolve('ABC'); await stopped;
    assert.equal(f.original.getSnapshot().revision, revision + 1, 'host-guarded final checkpoint confirms persistence before releasing audio');
    assert.equal(f.original.getSnapshot().text, 'hello ABC');
    assert.equal(f.original.getSnapshot().blocks.length, 0);
    f.text('late'); assert.equal(f.original.getSnapshot().text, 'hello ABC');
  }
});
test('silent recordings preserve selections and empty finals restore only owned provisional text', async t => {
  for (const provisional of [false, true]) {
    const f = fixture(); t.after(() => f.service.dispose());
    await f.service.start();
    if (provisional) { f.text('temporary'); assert.equal(f.original.getSnapshot().text, 'hello temporary'); }
    f.text('');
    assert.equal(f.original.getSnapshot().text, 'hello world');
    const revision = f.original.getSnapshot().revision;
    const stopped = f.service.stop(); f.result.resolve(''); await stopped;
    assert.equal(f.original.getSnapshot().text, 'hello world');
    assert.equal(f.original.getSnapshot().revision, revision + 1, 'final checkpoint preserves text while confirming persistence');
    assert.equal(f.service.getSnapshot().recovery, null);
    assert.equal(f.service.getSnapshot().phase, 'idle');
    assert.match(f.service.getSnapshot().notice!, /未识别到语音/);
  }
});
test('manual edits and peer leases stop live writes while preserving the latest composed result', async t => {
  for (const cause of ['revision', 'peer', 'pending']) {
    const f = fixture(); t.after(() => f.service.dispose());
    await f.service.start(); f.text('first');
    if (cause === 'revision') f.original.editText('manual edit');
    if (cause === 'peer') f.original.state.set({ ...f.original.getSnapshot(), blocks: [...f.original.getSnapshot().blocks, { id: 'peer', reason: 'busy' }] });
    if (cause === 'pending') f.original.state.set({ ...f.original.getSnapshot(), pending: true });
    const before = f.original.getSnapshot().text;
    f.text('first second');
    assert.equal(f.service.ownsDraft(f.original.id), false);
    assert.equal(f.original.getSnapshot().text, before);
    const stopped = f.service.stop(); f.result.resolve('first second final'); await stopped;
    assert.equal(f.original.getSnapshot().text, before);
    assert.equal(f.service.getSnapshot().recovery?.text, 'first second final');
  }
});
test('replay updates the same draft region and clear preserves received text while rejecting late writes', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); f.text('partial first attempt');
  const stopped = f.service.stop(); f.result.reject(new SpeechError('CONNECTION_CLOSED', 'Disconnected')); await stopped;
  const retry = f.service.retry();
  f.text('replayed'); assert.equal(f.original.getSnapshot().text, 'hello replayed');
  f.retryResult.resolve('replayed final'); await retry;
  assert.equal(f.original.getSnapshot().text, 'hello replayed final');
  await f.service.start(); f.text('next');
  const before = f.original.getSnapshot().text;
  f.service.clear(); f.text('late');
  assert.equal(f.original.getSnapshot().text, before);
  assert.equal(f.original.getSnapshot().blocks.length, 0);
});
test('failed-stream recovery can be inserted or discarded without a dead retained operation', async t => {
  for (const action of ['insert', 'discard']) {
    const f = fixture(); t.after(() => f.service.dispose());
    await f.service.start(); f.text('first');
    f.original.editText('manual words');
    f.text('partial recovery');
    const stopped = f.service.stop();
    f.result.reject(new SpeechError('CONNECTION_CLOSED', 'Disconnected')); await stopped;
    assert.equal(f.service.hasRetainedRecording(), true);
    assert.equal(f.service.getSnapshot().recovery?.text, 'partial recovery');
    f.text('late failed attempt');
    assert.equal(f.service.getSnapshot().recovery?.text, 'partial recovery');
    assert.equal(f.service.canInsert(), true);
    if (action === 'insert') f.service.insertRecovery();
    else f.service.dismiss();
    assert.equal(f.original.getSnapshot().text, action === 'insert' ? 'manualpartial recovery words' : 'manual words');
    assert.equal(f.service.getSnapshot().phase, 'idle');
    assert.equal(f.service.getSnapshot().recovery, null);
    assert.equal(f.service.hasRetainedRecording(), false);
    assert.equal(f.service.canStart(), true);
    f.text('later callback');
    assert.equal(f.original.getSnapshot().text, action === 'insert' ? 'manualpartial recovery words' : 'manual words');
  }
});
test('elapsed time follows captured samples and clear resets retained operations without changing drafts', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
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
    assert.equal(f.values().capturedContext, purpose.kind === 'ask'
      ? 'Question: Synthetic question?\nChoices:\n- Alpha\n- Beta' : 'initial context');
    assert.equal(f.service.getSnapshot().recovery, null);
    assert.deepEqual(f.service.getSnapshot().focus, {
      id: f.original.id, revision: f.original.getSnapshot().revision, selection: { start: 12, end: 12 }, activate: false,
    });
  }
});
test('ask captures only its bound question before permission, even with an unavailable chat window', async t => {
  const f = fixture({ purpose: { kind: 'ask', requestId: 'question' }, permission: true });
  t.after(() => f.service.dispose());
  f.chatWindow.set({ ...f.chatWindow.getSnapshot(), status: 'unavailable', sessionId: 'other' });
  const starting = f.service.start();
  assert.equal(f.values().capturedContext, 'Question: Synthetic question?\nChoices:\n- Alpha\n- Beta');
  f.original.state.set({ ...f.original.getSnapshot(), askContext: { question: 'Changed while asking permission' } });
  f.permission.resolve(f.recording); await starting;
  assert.equal(f.values().capturedContext, 'Question: Synthetic question?\nChoices:\n- Alpha\n- Beta');
  assert.equal(f.service.getSnapshot().notice, null);
});
test('missing ask question explicitly degrades to audio only, never the latest ordinary reply', async t => {
  for (const askContext of [undefined, { question: ' ', choices: ['Alpha'] }]) {
    const f = fixture({ purpose: { kind: 'ask', requestId: 'question' } });
    t.after(() => f.service.dispose());
    f.original.state.set({ ...f.original.getSnapshot(), askContext });
    await f.service.start();
    assert.equal(f.values().capturedContext, undefined);
    assert.equal(f.service.getSnapshot().notice, '当前问题参考不可用，将仅根据录音转写。');
    assert.equal(f.service.getSnapshot().phase, 'recording');
    const stopped = f.service.stop(); f.result.resolve('audio only'); await stopped;
    assert.equal(f.original.getSnapshot().text, 'hello audio only');
  }
});
test('a hidden ask task retains context across session switching and retry, not a replacement question', async t => {
  const f = fixture({ purpose: { kind: 'ask', requestId: 'reused' } });
  t.after(() => f.service.dispose());
  await f.service.start();
  f.host.set({ ...f.host.getSnapshot(), sessionId: 'other' });
  f.service.clearTarget(f.original.id);
  await turn();
  f.result.reject(new SpeechError('NETWORK', 'Synthetic failure'));
  await turn();
  const other = { ...draft('other-session', { kind: 'ask', requestId: 'reused' }), sessionId: 'other' };
  other.state.set({ ...other.getSnapshot(), askContext: { question: 'Other session question' } });
  f.service.setTarget({ draft: other, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  assert.equal(f.service.canRetry(f.original.id), false);
  f.original.state.set({ ...f.original.getSnapshot(), askContext: { question: 'Updated original question' } });
  f.host.set({ ...f.host.getSnapshot(), sessionId: 's' });
  f.service.setTarget({ draft: f.original, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  const retried = f.service.retry();
  f.retryResult.resolve('original answer'); await retried;
  assert.equal(f.values().captures, 1);
  assert.equal(f.values().capturedContext, 'Question: Synthetic question?\nChoices:\n- Alpha\n- Beta');
  assert.equal(other.getSnapshot().text, 'hello world');
  assert.equal(f.original.getSnapshot().text, 'hello original answer');
});
test('retired ask audio cannot supply context or results to a reused request ID lifetime', async t => {
  const f = fixture({ purpose: { kind: 'ask', requestId: 'reused' } });
  t.after(() => f.service.dispose());
  await f.service.start();
  const stopped = f.service.stop();
  f.original.state.set({ ...f.original.getSnapshot(), retired: true, askContext: undefined });
  const replacement = draft('new-ask-lifetime', { kind: 'ask', requestId: 'reused' });
  replacement.state.set({ ...replacement.getSnapshot(), askContext: { question: 'Replacement question?', choices: ['Gamma'] } });
  f.service.setTarget({ draft: replacement, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  assert.equal(f.service.hasRetainedRecording(f.original.id), false);
  f.result.resolve('late original answer'); await stopped;
  assert.equal(replacement.getSnapshot().text, 'hello world');
  await f.service.start();
  assert.equal(f.values().capturedContext, 'Question: Replacement question?\nChoices:\n- Gamma');
  assert.equal(f.values().captures, 2);
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
  assert.equal(f.service.getSnapshot().focus?.activate, true, 'explicit recovery insertion returns to the editor');
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
