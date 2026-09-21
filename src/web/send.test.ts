import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { DraftPurpose, DraftSendResult, HostSnapshot, ModuleDraft, ModuleDraftSnapshot } from '@cockpit/module-api';
import { SpeechError } from '../shared/limits.ts';
import type { Recording } from './recorder.ts';
import { SpeechService } from './speech.ts';
import { HOLD_DELAY, HoldGesture } from './hold.ts';
import { KeyboardHold } from './keyboard.ts';
import { keyboardDOM } from './keyboard.fixture.test.ts';

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
  };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(t: TestContext) {
  const host = store<HostSnapshot>({ sessionId: 'original-session', visible: true, connected: true });
  const requests: { id: string; sessionId: string; purpose: DraftPurpose; text: string; attachment: string }[] = [];
  function owner(id: string, sessionId = 'original-session', purpose: DraftPurpose = { kind: 'prompt' }) {
    const state = store<ModuleDraftSnapshot>({ text: '', revision: 0, pending: false, unconfirmed: false,
      retired: false, hasContent: false, blocks: [] });
    const reply = deferred<DraftSendResult>();
    let captures = 0, sendCalls = 0, lease = 0, fieldRevision = 0, attachment = '';
    let captureError = false;
    const draft: ModuleDraft = {
      id, sessionId, purpose, subscribe: state.subscribe, getSnapshot: state.getSnapshot,
      editText(text) { state.set({ ...state.getSnapshot(), text, revision: state.getSnapshot().revision + 1, hasContent: !!text || !!attachment }); },
      editTextIfRevision(text, revision) {
        const value = state.getSnapshot();
        if (value.retired) throw new Error('Retired');
        if (value.revision !== revision || value.pending || value.unconfirmed || value.blocks.length) return false;
        this.editText(text); return true;
      },
      block(reason) {
        const id = String(++lease);
        state.set({ ...state.getSnapshot(), blocks: [...state.getSnapshot().blocks, { id, reason }] });
        return () => state.set({ ...state.getSnapshot(), blocks: state.getSnapshot().blocks.filter(block => block.id !== id) });
      },
      captureSend() {
        captures++;
        if (captureError) throw new Error('No host authorization');
        const capturedFields = fieldRevision;
        let sent: Promise<DraftSendResult> | undefined;
        let cancelled = false;
        return {
          cancel() { cancelled = true; },
          send(revision) {
            sendCalls++;
            if (sent) return sent;
            const value = state.getSnapshot();
            if (cancelled || value.retired || value.pending || value.unconfirmed || value.blocks.length
              || value.revision !== revision || capturedFields !== fieldRevision) {
              return sent = Promise.resolve({ status: 'blocked', reason: 'draft-changed' });
            }
            requests.push({ id, sessionId, purpose, text: value.text, attachment });
            state.set({ ...value, pending: true });
            return sent = reply.promise.then(result => {
              const latest = state.getSnapshot();
              state.set({ ...latest, pending: false, unconfirmed: result.status === 'unconfirmed',
                ...(result.status === 'acknowledged' && latest.revision === revision ? { text: '', revision: revision + 1 } : {}) });
              return result;
            });
          },
        };
      },
    };
    const value = { draft, state, reply, captures: () => captures, sendCalls: () => sendCalls,
      denyCapture: () => { captureError = true; },
      attach: (next: string) => { attachment = next; fieldRevision++; state.set({ ...state.getSnapshot(), hasContent: !!next || !!state.getSnapshot().text }); } };
    return value;
  }
  const takes: { signal: AbortSignal; stop: ReturnType<typeof deferred<string>>; retry: ReturnType<typeof deferred<string>>;
    permission: ReturnType<typeof deferred<Recording>>; recording: Recording; stops: number; retries: number;
    text(value: string): void; fail(error: SpeechError): void; limit(): void }[] = [];
  let waitPermission = false;
  const service = new SpeechService({
    signal: new AbortController().signal, host,
    chatWindow: { getSnapshot: () => ({ sessionId: null, status: 'unavailable', hasMore: false, partial: false, messages: [] }), subscribe: () => () => {} },
    session: async () => { throw new Error('No real network'); }, report: () => assert.fail('No global notification'),
    prepare(signal, fail, limit) {
      const take = { signal, fail, limit, stop: deferred<string>(), retry: deferred<string>(),
        permission: deferred<Recording>(), recording: {} as Recording, stops: 0, retries: 0, text: (_text: string) => {} };
      take.recording = {
        stop: async committed => { take.stops++; committed?.(); return take.stop.promise; },
        retry: async committed => { take.retries++; committed?.(); return take.retry.promise; },
        retryable: () => !signal.aborted, cancel() {},
      };
      takes.push(take);
      return { cancel() {}, async start(_session, _context, options) {
        take.text = options?.onText ?? take.text;
        return waitPermission ? take.permission.promise : take.recording;
      } };
    },
  });
  const select = (value: ReturnType<typeof owner>) => {
    host.set({ ...host.getSnapshot(), sessionId: value.draft.sessionId });
    service.setTarget({ draft: value.draft, disabled: false, sendBlocked: false, selection: () => ({ start: 0, end: 0 }) });
  };
  const original = owner('original');
  select(original);
  t.after(() => service.dispose());
  return { service, host, requests, takes, original, owner, select, waitPermission: () => { waitPermission = true; } };
}

test('active hold release submits the original full draft once, not individual VAD turns', async t => {
  for (const purpose of [{ kind: 'prompt' }, { kind: 'ask', requestId: 'original-ask' }, { kind: 'plan', requestId: 'original-plan' }] as const) {
    const f = fixture(t);
    const original = f.owner('purpose-input', 'original-session', purpose); f.select(original);
    original.attach('existing-attachment');
    await f.service.start('hold');
    const take = f.takes[0]!;
    take.text('first'); take.text('first second');
    assert.equal(f.requests.length, 0);
    const release = f.service.releaseHold();
    assert.equal(original.captures(), 1);
    assert.equal(f.requests.length, 0);
    await f.service.releaseHold(); await f.service.stop();
    take.text('first second third');
    assert.equal(f.requests.length, 0);
    take.stop.resolve('complete transcript'); await turn();
    assert.equal(f.service.getSnapshot().phase, 'sending');
    assert.deepEqual(f.requests, [{ id: 'purpose-input', sessionId: 'original-session', purpose, text: 'complete transcript', attachment: 'existing-attachment' }]);
    assert.equal(take.signal.aborted, false, 'audio remains until native acknowledgement');
    take.text('late'); take.fail(new SpeechError('AUDIO_FAILED', 'late failure'));
    assert.equal(f.service.getSnapshot().phase, 'sending');
    original.reply.resolve({ status: 'acknowledged' }); await release;
    assert.equal(f.service.getSnapshot().phase, 'idle');
    assert.equal(take.signal.aborted, true);
    assert.equal(original.draft.getSnapshot().text, '');
    assert.equal(original.sendCalls(), 1);
  }
});

test('send intent survives session/tab/ask navigation only when interruption follows active release', async t => {
  for (const afterRelease of [false, true]) for (const cause of ['session', 'ask', 'hidden', 'unmount'] as const) {
    await t.test(`${cause} afterRelease=${afterRelease}`, async t => {
      const f = fixture(t);
      await f.service.start('hold');
      const take = f.takes[0]!;
      const release = afterRelease ? f.service.releaseHold() : undefined;
      const other = f.owner('other', cause === 'session' ? 'other-session' : 'original-session', { kind: 'ask', requestId: 'new-ask' });
      if (cause === 'session' || cause === 'ask') f.select(other);
      if (cause === 'hidden') f.host.set({ ...f.host.getSnapshot(), visible: false });
      if (cause === 'unmount') f.service.clearTarget('original');
      await f.service.releaseHold('original');
      take.stop.resolve('original message'); await turn();
      assert.equal(f.requests.length, afterRelease ? 1 : 0);
      if (afterRelease) {
        assert.equal(f.requests[0]!.id, 'original');
        assert.equal(f.requests[0]!.purpose.kind, 'prompt', 'a later ask cannot turn a prompt into an answer');
        assert.equal(f.requests[0]!.sessionId, 'original-session');
        f.original.reply.resolve({ status: 'acknowledged' }); await release;
      } else assert.equal(f.original.draft.getSnapshot().text, 'original message');
      assert.equal(other.draft.getSnapshot().text, '');
      assert.equal(other.captures(), 0);
      assert.equal(take.stops, 1);
    });
  }
});

test('button stop, hold interruption, explicit cancellation and late permission never authorize send', async t => {
  for (const action of ['button', 'interrupt', 'cancel', 'permission'] as const) {
    const f = fixture(t);
    if (action === 'permission') f.waitPermission();
    const starting = f.service.start(action === 'button' ? 'button' : 'hold');
    const take = f.takes[0]!;
    if (action !== 'permission') await starting;
    if (action === 'button') { await f.service.releaseHold(); void f.service.stop(); }
    if (action === 'interrupt' || action === 'permission') f.service.interrupt();
    if (action === 'cancel') f.service.cancel();
    await f.service.releaseHold();
    take.permission.resolve(take.recording); take.stop.resolve('draft only');
    await starting; await turn();
    assert.equal(f.original.captures(), 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.original.draft.getSnapshot().text, action === 'button' || action === 'interrupt' ? 'draft only' : '');
  }
});
test('post-release view gates do not replace captured native send authority', async t => {
  const f = fixture(t);
  await f.service.start('hold');
  const take = f.takes[0]!;
  take.limit();
  assert.equal(f.service.getSnapshot().holdingAtLimit, true);
  const release = f.service.releaseHold();
  f.service.setTarget({ draft: f.original.draft, disabled: true, sendBlocked: true, selection: () => ({ start: 0, end: 0 }) });
  take.text('late original transcript');
  take.stop.resolve('late original transcript'); await turn();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.id, 'original');
  f.original.reply.resolve({ status: 'acknowledged' }); await release;
});

test('transcription retry preserves release intent but does not send until full retry completion', async t => {
  const f = fixture(t);
  await f.service.start('hold');
  const take = f.takes[0]!;
  const release = f.service.releaseHold();
  take.stop.reject(new SpeechError('NETWORK', 'Synthetic offline')); await release;
  assert.equal(f.service.getSnapshot().phase, 'retry');
  assert.equal(f.service.getSnapshot().sendRequested, true);
  assert.equal(f.requests.length, 0);
  const retry = f.service.retry();
  f.select(f.owner('other', 'other-session'));
  take.text('partial replay');
  assert.equal(f.requests.length, 0);
  take.retry.resolve('complete replay'); await turn();
  assert.equal(f.requests[0]!.text, 'complete replay');
  f.original.reply.resolve({ status: 'acknowledged' }); await retry;
  assert.equal(f.original.captures(), 1);
  assert.equal(take.retries, 1);
  assert.equal(f.requests.length, 1);
});
test('independent prompt and ask releases in one session keep separate native purposes and ACKs', async t => {
  const f = fixture(t);
  await f.service.start('hold');
  const prompt = f.takes[0]!;
  const promptRelease = f.service.releaseHold();
  const answer = f.owner('answer', 'original-session', { kind: 'ask', requestId: 'question' });
  f.select(answer);
  await f.service.start('hold');
  const ask = f.takes[1]!;
  const askRelease = f.service.releaseHold();
  ask.stop.resolve('answer text'); prompt.stop.resolve('ordinary message'); await turn();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests.find(request => request.id === 'answer')!.purpose.kind, 'ask');
  assert.equal(f.requests.find(request => request.id === 'original')!.purpose.kind, 'prompt');
  answer.reply.resolve({ status: 'acknowledged' }); await askRelease;
  assert.equal(ask.signal.aborted, true);
  assert.equal(prompt.signal.aborted, false);
  f.original.reply.resolve({ status: 'unconfirmed', reason: 'native-unconfirmed' }); await promptRelease;
  assert.equal(f.service.getSnapshot('original').phase, 'send-error');
  assert.equal(f.service.getSnapshot('answer').phase, 'idle');
});

test('a text edit during final host publication cannot be adopted as the authorized send revision', async t => {
  const f = fixture(t);
  await f.service.start('hold');
  const take = f.takes[0]!;
  const release = f.service.releaseHold();
  let changed = false;
  const unsubscribe = f.original.draft.subscribe(() => {
    if (!changed && f.original.draft.getSnapshot().text === 'recognized') {
      changed = true; f.original.draft.editText('later manual content');
    }
  });
  take.stop.resolve('recognized'); await release;
  unsubscribe();
  assert.equal(f.requests.length, 0);
  assert.equal(f.original.draft.getSnapshot().text, 'later manual content');
  assert.equal(f.service.getSnapshot().sendOutcome, 'blocked');
  assert.equal(take.signal.aborted, false);
});

test('clearing an in-flight send cannot cancel or repeat its native ACK or affect a later task', async t => {
  const f = fixture(t);
  await f.service.start('hold');
  const take = f.takes[0]!;
  const release = f.service.releaseHold();
  take.stop.resolve('already dispatched'); await turn();
  f.service.clear();
  assert.equal(take.signal.aborted, true);
  assert.equal(f.service.canStart(), false, 'native pending ownership survives local clear');
  f.original.reply.resolve({ status: 'acknowledged' }); await release;
  assert.equal(f.requests.length, 1);
  await f.service.start('button');
  take.text('late'); take.fail(new SpeechError('NETWORK', 'late'));
  assert.equal(f.service.getSnapshot().phase, 'recording');
  assert.equal(f.original.draft.getSnapshot().text, '');
});
test('native acknowledgement owns only the submitted revision, not later unsent input', async t => {
  const f = fixture(t);
  await f.service.start('hold');
  const release = f.service.releaseHold();
  f.takes[0]!.stop.resolve('submitted words'); await turn();
  f.original.draft.editText('later unsent words');
  f.original.reply.resolve({ status: 'acknowledged' }); await release;
  assert.equal(f.requests[0]!.text, 'submitted words');
  assert.equal(f.requests.length, 1);
  assert.equal(f.original.draft.getSnapshot().text, 'later unsent words');
  assert.equal(f.service.getSnapshot().phase, 'idle');
});
test('explicit clear cancels a captured host intent whose deferred dispatch has not started', async t => {
  const f = fixture(t);
  let cancelled = false, dispatches = 0;
  let dispatch!: () => void;
  t.mock.method(f.original.draft, 'captureSend', () => ({
    cancel() { cancelled = true; },
    send: () => new Promise<DraftSendResult>(resolve => {
      dispatch = () => {
        if (cancelled) resolve({ status: 'blocked', reason: 'cancelled' });
        else { dispatches++; resolve({ status: 'acknowledged' }); }
      };
    }),
  }));
  await f.service.start('hold');
  const release = f.service.releaseHold();
  f.takes[0]!.stop.resolve('not dispatched yet'); await turn();
  assert.equal(f.service.getSnapshot().phase, 'sending');
  f.service.clear();
  dispatch(); await release;
  assert.equal(cancelled, true);
  assert.equal(dispatches, 0);
  assert.equal(f.service.getSnapshot().phase, 'idle');
});

test('post-release text, attachment and ABA edits prevent sending without losing audio or new input', async t => {
  for (const change of ['text', 'attachment', 'attachment-aba', 'pending', 'peer'] as const) {
    const f = fixture(t);
    f.original.attach('initial');
    await f.service.start('hold');
    const take = f.takes[0]!;
    const release = f.service.releaseHold();
    if (change === 'text') f.original.draft.editText('manual edit');
    if (change === 'attachment' || change === 'attachment-aba') f.original.attach('modified');
    if (change === 'attachment-aba') f.original.attach('initial');
    if (change === 'pending') f.original.state.set({ ...f.original.draft.getSnapshot(), pending: true });
    if (change === 'peer') f.original.draft.block('peer');
    take.stop.resolve('recognized'); await release;
    assert.equal(f.requests.length, 0);
    assert.equal(take.signal.aborted, false);
    assert.equal(f.service.getSnapshot().recovery?.text, 'recognized');
    if (change === 'text') assert.equal(f.original.draft.getSnapshot().text, 'manual edit');
    if (change.startsWith('attachment')) assert.equal(f.service.getSnapshot().sendOutcome, 'blocked');
  }
});

test('blocked and unknown native outcomes retain resources and never become transcription/send retry', async t => {
  for (const outcome of ['blocked', 'unconfirmed', 'throw'] as const) {
    const f = fixture(t);
    await f.service.start('hold');
    const take = f.takes[0]!;
    const release = f.service.releaseHold();
    take.stop.resolve('message'); await turn();
    if (outcome === 'throw') f.original.reply.reject(new Error('Synthetic unknown delivery'));
    else f.original.reply.resolve(outcome === 'blocked'
      ? { status: 'blocked', reason: 'unavailable' } : { status: 'unconfirmed', reason: 'native-unconfirmed' });
    await release;
    assert.equal(f.service.getSnapshot().phase, 'send-error');
    assert.equal(f.service.getSnapshot().sendOutcome, outcome === 'blocked' ? 'blocked' : 'unconfirmed');
    assert.equal(f.service.canRetry(), false);
    assert.equal(f.service.canStart(), false);
    assert.equal(f.service.canInsert(), false);
    assert.equal(take.signal.aborted, false);
    await f.service.retry(); await f.service.releaseHold(); await f.service.stop();
    f.service.interrupt(); f.select(f.owner('other')); f.select(f.original);
    assert.equal(f.requests.length, 1);
    assert.equal(f.original.sendCalls(), 1);
    assert.equal(f.service.getSnapshot().phase, 'send-error');
    f.service.clear();
    assert.equal(take.signal.aborted, true);
  }
});

test('hidden sending and unconfirmed results retain unload protection until explicit clear', async t => {
  const f = fixture(t);
  await f.service.start('hold');
  const release = f.service.releaseHold();
  f.takes[0]!.stop.resolve('recognized'); await turn();
  assert.equal(f.service.getSnapshot().phase, 'sending');
  assert.equal(f.service.hasUnpersistedWork(), true);
  f.select(f.owner('different', 'other-session'));
  assert.equal(f.service.getSnapshot().phase, 'idle');
  assert.equal(f.service.hasUnpersistedWork(), true);
  f.original.reply.resolve({ status: 'unconfirmed', reason: 'native-unconfirmed' }); await release;
  assert.equal(f.service.getSnapshot('original').sendOutcome, 'unconfirmed');
  assert.equal(f.original.draft.getSnapshot().blocks.length, 0);
  assert.equal(f.service.hasUnpersistedWork(), true);
  assert.equal(f.requests.length, 1);
  f.service.clear('original');
  assert.equal(f.service.hasUnpersistedWork(), false);
  assert.equal(f.requests.length, 1);
});

test('empty recognition never sends even existing attachments; too-short and cleared tasks also never send', async t => {
  for (const outcome of ['empty', 'short', 'clear', 'retire', 'denied'] as const) {
    const f = fixture(t);
    f.original.attach('original attachment');
    if (outcome === 'denied') f.original.denyCapture();
    await f.service.start('hold');
    const take = f.takes[0]!;
    const release = f.service.releaseHold();
    if (outcome === 'clear') f.service.clear();
    if (outcome === 'retire') f.original.state.set({ ...f.original.draft.getSnapshot(), retired: true });
    if (outcome === 'short') take.stop.reject(new SpeechError('AUDIO_TOO_SHORT', 'Too short'));
    else take.stop.resolve(outcome === 'empty' ? '' : 'transcript');
    await release;
    assert.equal(f.requests.length, 0);
    assert.equal(take.signal.aborted, outcome !== 'denied');
    if (outcome === 'denied') assert.equal(f.service.getSnapshot().sendOutcome, 'blocked');
  }
});

test('real hold gesture release authorizes once; interruption clears ownership before trailing pointerup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const interrupted of [false, true]) {
    const f = fixture(t);
    const gesture = new HoldGesture({
      allowed: () => f.service.canStart(), bounds: () => ({ left: 0, top: 0, right: 100, bottom: 100 }),
      phase: () => f.service.getSnapshot().phase, start: () => { void f.service.start('hold'); },
      stop: () => { void f.service.releaseHold(); }, interrupt: () => f.service.interrupt(),
      cancel: () => f.service.cancel(), focus() {},
    });

    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 10, clientY: 10 };
    gesture.down(point, { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() { gesture.lost(1); } });
    t.mock.timers.tick(HOLD_DELAY); await turn();
    if (interrupted) gesture.interrupt();
    gesture.up(point); gesture.up(point); gesture.lost(1);
    f.takes[0]!.stop.resolve('one message'); await turn();
    assert.equal(f.requests.length, interrupted ? 0 : 1);
    f.original.reply.resolve({ status: 'acknowledged' }); await turn();
  }
});

function keyboardFixture(t: TestContext, f: ReturnType<typeof fixture>, original = f.original) {
  const dom = keyboardDOM();
  const keyboard = new KeyboardHold();
  const editor = dom.editor();
  const unregister = keyboard.register({
    editor: () => editor as unknown as HTMLTextAreaElement,
    available: () => f.host.getSnapshot().visible && f.host.getSnapshot().connected
      && f.host.getSnapshot().sessionId === original.draft.sessionId && !original.draft.getSnapshot().retired,
    empty: () => original.draft.getSnapshot().text === '',
    canStart: () => f.service.canStart(original.draft.id),
    canContinue: () => original.draft.getSnapshot().text === '' || f.service.ownsDraft(original.draft.id),
    phase: () => f.service.getSnapshot(original.draft.id).phase,
    start: () => { void f.service.start('hold', original.draft.id, { focusOnCompletion: false }); },
    release: () => { void f.service.releaseHold(original.draft.id); },
    interrupt: () => f.service.interrupt(original.draft.id),
    cancel: () => f.service.cancel(original.draft.id),
  }, dom.document as unknown as Document, dom.window as unknown as Window);
  const unsubscribe = f.service.subscribe(keyboard.refresh);
  t.after(() => { unsubscribe(); keyboard.dispose(); });
  return { ...dom, keyboard, unregister };
}

test('F8 sends one complete original prompt/ask/plan through captureSend and native ACK', async t => {
  for (const purpose of [{ kind: 'prompt' }, { kind: 'ask', requestId: 'question' }, { kind: 'plan', requestId: 'plan' }] as const) {
    const f = fixture(t);
    const original = f.owner('keyboard-original', 'original-session', purpose);
    f.select(original); original.attach('attachment');
    const k = keyboardFixture(t, f, original);
    k.key('keydown'); k.key('keydown', { repeat: true }); await turn();
    f.takes[0]!.text('live words');
    k.key('keyup'); k.key('keyup');
    f.select(f.owner('other', 'other-session'));
    k.unregister();
    f.takes[0]!.stop.resolve('complete words'); await turn();
    assert.deepEqual(f.requests, [{ id: original.draft.id, sessionId: 'original-session', purpose, text: 'complete words', attachment: 'attachment' }]);
    assert.equal(original.captures(), 1);
    original.reply.resolve({ status: 'acknowledged' }); await turn();
    assert.equal(original.sendCalls(), 1);
    assert.equal(f.takes[0]!.signal.aborted, true);
  }
});

test('F8 pre-release switch/rebind/hidden/blur/escape/external edit cannot authorize a late release', async t => {
  for (const reason of ['session', 'ask', 'rebind', 'hidden', 'blur', 'escape', 'external-text'] as const) {
    const f = fixture(t);
    const k = keyboardFixture(t, f);
    k.key('keydown'); await turn();
    if (reason === 'session') f.select(f.owner('other', 'other-session'));
    if (reason === 'ask') f.select(f.owner('ask', 'original-session', { kind: 'ask', requestId: 'replacement' }));
    if (reason === 'rebind') k.unregister();
    if (reason === 'hidden') f.host.set({ ...f.host.getSnapshot(), visible: false });
    if (reason === 'blur') k.window.dispatchEvent(new Event('blur'));
    if (reason === 'escape') k.key('keydown', { key: 'Escape' });
    if (reason === 'external-text') f.original.draft.editText('manual text');
    k.key('keyup'); k.key('keyup');
    f.takes[0]!.stop.resolve('recognized'); await turn();
    assert.equal(f.requests.length, 0, reason);
    assert.equal(f.original.captures(), 0, reason);
    assert.equal(f.original.draft.getSnapshot().text,
      reason === 'escape' ? '' : reason === 'external-text' ? 'manual text' : 'recognized', reason);
    assert.equal(f.service.getSnapshot('original').focus, null, 'keyboard completion never steals focus after interruption');
  }
});

test('F8 preserves silence, post-release schema/text guards and uncertain ACK without resend', async t => {
  for (const outcome of ['silence', 'text', 'schema', 'unconfirmed'] as const) {
    const f = fixture(t);
    const k = keyboardFixture(t, f);
    f.original.attach('initial');
    k.key('keydown'); await turn(); k.key('keyup');
    if (outcome === 'text') f.original.draft.editText('manual');
    if (outcome === 'schema') { f.original.attach('changed'); f.original.attach('initial'); }
    f.takes[0]!.stop.resolve(outcome === 'silence' ? '' : 'words'); await turn();
    if (outcome === 'unconfirmed') {
      f.original.reply.resolve({ status: 'unconfirmed', reason: 'native-unconfirmed' }); await turn();
      k.key('keydown'); k.key('keyup'); await f.service.retry();
      assert.equal(f.service.getSnapshot().sendOutcome, 'unconfirmed');
    }
    assert.equal(f.requests.length, outcome === 'unconfirmed' ? 1 : 0, outcome);
    assert.equal(f.original.captures(), 1);
  }
});
