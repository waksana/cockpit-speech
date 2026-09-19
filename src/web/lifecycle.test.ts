import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ChatWindowSnapshot, DraftPurpose, HostSnapshot, ModuleDraft, ModuleDraftSnapshot } from '@cockpit/module-api';
import { SpeechError } from '../shared/limits.ts';
import type { Recording } from './recorder.ts';
import { SpeechService } from './speech.ts';
import { HOLD_DELAY, HoldGesture } from './hold.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next: T) => { value = next; for (const listener of [...listeners]) listener(); },
    listeners,
  };
}
function makeDraft(id: string, sessionId = 's', purpose: DraftPurpose = { kind: 'prompt' }) {
  const state = store<ModuleDraftSnapshot>({
    text: 'before after', revision: 0, pending: false, unconfirmed: false, retired: false, blocks: [], hasContent: true,
  });
  let lease = 0;
  let rejected = false;
  const draft: ModuleDraft = {
    id, sessionId, purpose, getSnapshot: state.getSnapshot, subscribe: state.subscribe,
    editText(text) { state.set({ ...state.getSnapshot(), text, revision: state.getSnapshot().revision + 1 }); },
    editTextIfRevision(text, revision) {
      const value = state.getSnapshot();
      if (rejected || value.retired) throw new Error('Draft unavailable');
      if (value.revision !== revision || value.pending || value.unconfirmed || value.blocks.length) return false;
      this.editText(text);
      return true;
    },
    block(reason) {
      if (state.getSnapshot().retired) throw new Error('Draft retired');
      const id = String(++lease);
      state.set({ ...state.getSnapshot(), blocks: [...state.getSnapshot().blocks, { id, reason }] });
      return () => state.set({ ...state.getSnapshot(), blocks: state.getSnapshot().blocks.filter(block => block.id !== id) });
    },
  };
  return { draft, state, rejectWrite: () => { rejected = true; } };
}
function fixture(t: TestContext) {
  const host = store<HostSnapshot>({ sessionId: 's', visible: true, connected: true });
  const chatWindow = store<ChatWindowSnapshot>({
    sessionId: 's', status: 'unavailable', hasMore: false, partial: false, messages: [],
  });
  const controller = new AbortController();
  const takes: {
    signal: AbortSignal; permission: ReturnType<typeof deferred<Recording>>;
    flush: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<string>>;
    replay: ReturnType<typeof deferred<string>>; recording: Recording;
    stops: number; retries: number; cancels: number; hardware: boolean;
    fail(error: SpeechError): void; level(value: number, seconds: number): void;
    text(value: string): void;
  }[] = [];
  let delayPermission = false;
  let delayFlush = false;
  const service = new SpeechService({
    signal: controller.signal, host, chatWindow, report: () => assert.fail('no global errors'),
    session: async () => { throw new Error('No real network'); },
    prepare(signal, fail) {
      const take = {
        signal, permission: deferred<Recording>(), flush: deferred<void>(), result: deferred<string>(),
        replay: deferred<string>(), recording: {} as Recording,
        stops: 0, retries: 0, cancels: 0, hardware: true, fail,
        level: (_value: number, _seconds: number) => {},
        text: (_value: string) => {},
      };
      take.recording = {
        stop: async committed => {
          take.stops++; take.hardware = false;
          await take.flush.promise;
          committed?.();
          return take.result.promise;
        },
        retry: async committed => { take.retries++; committed?.(); return take.replay.promise; },
        retryable: () => !take.signal.aborted,
        cancel: () => { take.cancels++; take.hardware = false; },
      };
      takes.push(take);
      if (!delayFlush) take.flush.resolve();
      return {
        cancel() { take.hardware = false; },
        async start(_session, _context, options) {
          take.level = options?.onLevel ?? take.level;
          take.text = options?.onText ?? take.text;
          return delayPermission ? take.permission.promise : take.recording;
        },
      };
    },
  });
  const original = makeDraft('prompt');
  const select = (value: ReturnType<typeof makeDraft>) => {
    host.set({ ...host.getSnapshot(), sessionId: value.draft.sessionId });
    service.setTarget({ draft: value.draft, disabled: false, sendBlocked: false, selection: () => ({ start: 7, end: 7 }) });
  };
  select(original);
  t.after(() => service.dispose());
  return { service, host, original, select, takes, controller,
    delayPermission: () => { delayPermission = true; },
    delayFlush: () => { delayFlush = true; } };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const departures = ['session', 'ask', 'hidden', 'unmount', 'disconnect'] as const;
type Departure = typeof departures[number];
function depart(f: ReturnType<typeof fixture>, cause: Departure) {
  const next = makeDraft(`next-${cause}`, cause === 'session' ? 'other' : 's',
    cause === 'ask' ? { kind: 'ask', requestId: 'question' } : { kind: 'prompt' });
  if (cause === 'session' || cause === 'ask') f.select(next);
  if (cause === 'hidden') f.host.set({ ...f.host.getSnapshot(), visible: false });
  if (cause === 'disconnect') f.host.set({ ...f.host.getSnapshot(), connected: false });
  if (cause === 'unmount') f.service.clearTarget(f.original.draft.id);
  return next;
}

test('button and hold departure matrix: permission, capture, flush, transcription and retry', async t => {
  for (const mode of ['button', 'hold'] as const) {
    for (const cause of departures) {
      for (const phase of ['permission', 'recording', 'stopping', 'transcribing', 'retry'] as const) {
        await t.test(`${mode} ${cause} ${phase}`, async t => {
          const f = fixture(t);
          if (phase === 'permission') f.delayPermission();
          if (phase === 'stopping') f.delayFlush();
          const starting = f.service.start(mode);
          const take = f.takes[0]!;
          if (phase !== 'permission') await starting;
          let finishing: Promise<void> | undefined;
          if (phase === 'stopping' || phase === 'transcribing' || phase === 'retry') {
            finishing = f.service.stop();
            if (phase !== 'stopping') await turn();
            if (phase === 'retry') {
              take.result.reject(new SpeechError('NETWORK', 'Synthetic offline'));
              await finishing;
            }
          }
          assert.equal(f.service.getSnapshot().phase, phase);
          const next = depart(f, cause);
          if (phase === 'permission') {
            assert.equal(take.signal.aborted, true);
            take.permission.resolve(take.recording);
            await starting;
            assert.equal(take.hardware, false);
            assert.equal(take.stops, 0);
            assert.equal(f.service.getSnapshot('prompt').phase, 'idle');
          } else if (phase === 'retry') {
            assert.equal(take.signal.aborted, false);
            assert.equal(f.service.getSnapshot('prompt').phase, 'retry');
            f.host.set({ sessionId: 's', visible: true, connected: true });
            f.select(f.original);
            assert.equal(f.service.canRetry(), true);
            const replay = f.service.retry();
            depart(f, cause);
            take.replay.resolve('replayed ');
            await replay;
            assert.equal(f.original.draft.getSnapshot().text, 'before replayed after');
            assert.equal(take.retries, 1);
          } else {
            assert.equal(take.hardware, false);
            assert.equal(take.signal.aborted, false);
            take.flush.resolve();
            take.result.resolve('spoken ');
            await finishing;
            await turn();
            assert.equal(f.original.draft.getSnapshot().text, 'before spoken after');
            assert.equal(take.stops, 1);
            assert.equal(take.signal.aborted, true, 'reliable insertion releases audio');
          }
          assert.equal(next.draft.getSnapshot().text, 'before after');
          assert.equal(f.original.draft.getSnapshot().blocks.length, 0);
          f.host.set({ sessionId: 's', visible: true, connected: true });
          f.select(f.original);
          assert.equal(f.service.getSnapshot().phase, 'idle');
          assert.equal(f.service.canStart(), true);
        });
      }
    }
  }
});

test('independent draft tasks transmit concurrently with one capture and no retained-task limit', async t => {
  const f = fixture(t);
  const drafts = [f.original, ...Array.from({ length: 6 }, (_, i) => makeDraft(`prompt-${i}`, `session-${i}`))];
  for (const owner of drafts) {
    f.select(owner);
    await f.service.start();
    assert.equal(f.service.canStart(), false, 'one capture and no second take for the same draft');
    assert.equal(f.takes.filter(take => take.hardware).length, 1);
  }
  f.service.interrupt(drafts.at(-1)!.draft.id);
  await turn();
  assert.equal(f.takes.filter(take => take.hardware).length, 0);
  assert.equal(f.takes.filter(take => !take.signal.aborted).length, 7, 'no silent eviction or network queue');
  for (const [index, take] of [...f.takes.entries()].reverse()) take.result.resolve(`result ${index} `);
  await turn();
  for (const [index, owner] of drafts.entries()) {
    assert.equal(owner.draft.getSnapshot().text, `before result ${index} after`);
    assert.equal(owner.draft.getSnapshot().blocks.length, 0);
    assert.equal(owner.state.listeners.size, 0);
  }
});

test('returning to a failed draft restores only its retry and cannot replace it with a new take', async t => {
  const f = fixture(t);
  await f.service.start();
  const first = f.takes[0]!;
  const answer = depart(f, 'ask');
  await turn();
  first.result.reject(new SpeechError('NETWORK', 'Original failure'));
  await turn();
  await f.service.start();
  const second = f.takes[1]!;
  first.level(0.9, 90);
  assert.equal(f.service.getSnapshot().phase, 'recording');
  assert.equal(f.service.getSnapshot().error, null);
  assert.equal(f.service.getSnapshot().level, 0);
  f.select(f.original);
  assert.equal(f.service.getSnapshot().error, 'Original failure');
  assert.equal(f.service.canStart(), false);
  await f.service.start();
  assert.equal(f.takes.length, 2);
  const retry = f.service.retry();
  first.replay.resolve('original ');
  second.result.resolve('answer ');
  await retry; await turn();
  assert.equal(f.original.draft.getSnapshot().text, 'before original after');
  assert.equal(answer.draft.getSnapshot().text, 'before answer after');
});

test('streamed text and retry replace only the original region after ask/session navigation', async t => {
  for (const cause of ['ask', 'session'] as const) {
    const f = fixture(t);
    await f.service.start('hold');
    const first = f.takes[0]!;
    first.text('early ');
    assert.equal(f.original.draft.getSnapshot().text, 'before early after');
    const next = depart(f, cause);
    await f.service.start();
    const second = f.takes[1]!;
    first.text('background ');
    second.text('other ');
    assert.equal(f.original.draft.getSnapshot().text, 'before background after');
    assert.equal(next.draft.getSnapshot().text, 'before other after');
    await turn();
    first.result.reject(new SpeechError('NETWORK', 'Background failed')); await turn();
    first.text('late failed callback ');
    assert.equal(f.original.draft.getSnapshot().text, 'before background after');
    f.select(f.original);
    const replay = f.service.retry();
    first.text('replayed ');
    assert.equal(f.original.draft.getSnapshot().text, 'before replayed after');
    first.replay.resolve('final ');
    second.result.resolve('other final ');
    await replay; await turn();
    assert.equal(f.original.draft.getSnapshot().text, 'before final after');
    assert.equal(next.draft.getSnapshot().text, 'before other final after');
    first.text('late success ');
    assert.equal(f.original.draft.getSnapshot().text, 'before final after');
  }
});

test('successful provisional writes do not release audio if the final durable checkpoint fails', async t => {
  const f = fixture(t);
  await f.service.start();
  const take = f.takes[0]!;
  take.text('live ');
  f.original.rejectWrite();
  depart(f, 'ask');
  take.result.resolve('live ');
  await turn();
  assert.equal(f.original.draft.getSnapshot().text, 'before live after');
  assert.equal(f.service.hasRetainedRecording('prompt'), true);
  assert.equal(f.service.getSnapshot('prompt').recovery?.text, 'live ');
  assert.match(f.service.getSnapshot('prompt').error!, /无法修改/);
  assert.equal(take.signal.aborted, false);
});

test('revision, send and write failures retain both text and audio until explicit insertion or discard', async t => {
  for (const conflict of ['edit', 'pending', 'unconfirmed', 'block', 'write-error'] as const) {
    await t.test(conflict, async t => {
      const f = fixture(t);
      await f.service.start();
      const take = f.takes[0]!;
      const next = depart(f, 'ask');
      const before = f.original.draft.getSnapshot();
      if (conflict === 'edit') f.original.draft.editText('manual');
      if (conflict === 'pending') f.original.state.set({ ...before, pending: true });
      if (conflict === 'unconfirmed') f.original.state.set({ ...before, unconfirmed: true });
      if (conflict === 'block') f.original.draft.block('peer');
      if (conflict === 'write-error') f.original.rejectWrite();
      take.result.resolve('kept ');
      await turn();
      assert.equal(take.signal.aborted, false);
      assert.equal(f.service.getSnapshot('prompt').recovery?.text, 'kept ');
      assert.equal(f.original.draft.getSnapshot().text, conflict === 'edit' ? 'manual' : 'before after');
      assert.equal(f.service.canInsert(next.draft.id), false);
      f.service.insertRecovery(next.draft.id);
      f.select(f.original);
      assert.equal(f.service.canStart(), false);
      if (conflict === 'edit') {
        f.service.insertRecovery();
        assert.equal(f.original.draft.getSnapshot().text, 'manualkept ');
        assert.equal(take.signal.aborted, true);
      } else {
        f.service.clear();
        assert.equal(take.signal.aborted, true);
      }
      assert.equal(f.original.state.listeners.size, 0);
    });
  }
});

test('authoritative retirement disposes hidden tasks in every phase and reused IDs never inherit them', async t => {
  for (const phase of ['permission', 'recording', 'stopping', 'transcribing', 'retry', 'recovery'] as const) {
    await t.test(phase, async t => {
      const f = fixture(t);
      const old = makeDraft('old-answer', 's', { kind: 'ask', requestId: 'reused' });
      f.select(old);
      if (phase === 'permission') f.delayPermission();
      if (phase === 'stopping') f.delayFlush();
      const starting = f.service.start();
      const take = f.takes[0]!;
      if (phase !== 'permission') await starting;
      if (['stopping', 'transcribing', 'retry', 'recovery'].includes(phase)) {
        void f.service.stop();
        await turn();
        if (phase === 'retry') take.result.reject(new SpeechError('NETWORK', 'Retry'));
        if (phase === 'recovery') { old.draft.editText('changed'); take.result.resolve('retained'); }
        await turn();
      }
      old.state.set({ ...old.draft.getSnapshot(), retired: true });
      assert.equal(take.signal.aborted, true);
      assert.equal(old.state.listeners.size, 0);
      assert.equal(old.draft.getSnapshot().blocks.length, 0);
      const replacement = makeDraft('new-answer', 's', { kind: 'ask', requestId: 'reused' });
      f.select(replacement);
      take.permission.resolve(take.recording);
      take.flush.resolve(); take.result.resolve('late');
      await starting; await turn();
      assert.equal(f.service.getSnapshot('old-answer').phase, 'idle');
      assert.equal(replacement.draft.getSnapshot().text, 'before after');
      assert.equal(f.service.canStart(), true);
    });
  }
});

test('hold interruption detaches pointer ownership before late release/swipe can discard background audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const gesture = new HoldGesture({
    allowed: () => f.service.canStart('prompt'), bounds: () => ({ left: 0, top: 0, right: 100, bottom: 100 }),
    phase: () => f.service.getSnapshot('prompt').phase,
    start: () => { void f.service.start('hold', 'prompt'); }, stop: () => { void f.service.stop('prompt'); },
    cancel: () => f.service.cancel('prompt'), interrupt: () => f.service.interrupt('prompt'), focus() {},
  });
  const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 20, clientY: 20 };
  let captured = false;
  gesture.down(point, { setPointerCapture() { captured = true; }, hasPointerCapture: () => captured,
    releasePointerCapture() { captured = false; gesture.lost(1); } });
  t.mock.timers.tick(HOLD_DELAY); await turn();
  gesture.interrupt();
  depart(f, 'ask');
  gesture.move({ ...point, clientY: -100 }); gesture.up(point); gesture.cancel();
  const take = f.takes[0]!;
  assert.equal(take.signal.aborted, false);
  take.result.resolve('held ');
  await turn();
  assert.equal(f.original.draft.getSnapshot().text, 'before held after');
  assert.equal(take.stops, 1);
});

test('module unload cancels every retained and pending task without late writes', async t => {
  const f = fixture(t);
  await f.service.start();
  depart(f, 'session');
  await f.service.start();
  f.controller.abort();
  for (const take of f.takes) {
    assert.equal(take.hardware, false);
    assert.equal(take.signal.aborted, true);
    take.result.resolve('late');
  }
  await turn();
  assert.equal(f.original.draft.getSnapshot().text, 'before after');
  assert.equal(f.original.state.listeners.size, 0);
});
