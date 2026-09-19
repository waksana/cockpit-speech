import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ComposerInputProps, ModuleDraft, ModuleFrontendContext } from '@cockpit/module-api';
import { activate } from './index.ts';
import { CANCEL_DISTANCE, HOLD_DELAY, HoldGesture } from './hold.ts';
import type { SpeechService } from './speech.ts';

type Element = { type: unknown; props: Record<string, unknown>; children: (Element | string | null)[] };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: TestContext, pointerType: 'mouse' | 'touch') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let captures = 0, contexts = 0, requests = 0, trackStops = 0, focuses = 0, leases = 0, intents = 0;
  let grant!: (stream: unknown) => void;
  const permission = new Promise(resolve => { grant = resolve; });
  const track = { readyState: 'live', stop() { trackStops++; this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage() { queueMicrotask(() => port.onmessage?.({ data: { type: 'ended', limited: false } })); },
    close() {},
  };
  const restoreGlobals: (() => void)[] = [];
  for (const [key, value] of Object.entries({
    window: new EventTarget(), document: new EventTarget(), isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia() { captures++; return permission; } } },
    AudioContext: class {
      state = 'running';
      destination = {};
      audioWorklet = { addModule: async () => {} };
      constructor() { contexts++; }
      async resume() {}
      async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    },
    AudioWorkletNode: class {
      port = port;
      connect() {}
      disconnect() {}
    },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restoreGlobals.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }

  // Preserve input hook identity and run changed layout effects after each render.
  // Unlike the phase-only rendering fixture, all snapshots and gestures are real.
  const slots: { deps?: readonly unknown[]; value?: unknown; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let gesture!: HoldGesture;
  const changed = (deps?: readonly unknown[]) => {
    const slot = slots[cursor] ?? (slots[cursor] = {});
    cursor++;
    const update = !deps || !slot.deps || deps.length !== slot.deps.length || deps.some((value, i) => !Object.is(value, slot.deps![i]));
    slot.deps = deps;
    return { slot, update };
  };
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const { slot, update } = changed(deps);
    if (update) slot.value = factory();
    if (slot.value instanceof HoldGesture) gesture = slot.value;
    return slot.value;
  };
  const host = { getSnapshot: () => ({ sessionId: 's', visible: true, connected: true }), subscribe: () => () => {} };
  let service!: SpeechService;
  const context = {
    apiVersion: 2, uiVersion: 1, chatWindowVersion: 1, composerInputVersion: 1, draftLifecycleVersion: 1, draftSubmissionVersion: 1,
    signal: new AbortController().signal,
    request: (_path: string, init: RequestInit) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    },
    report: () => assert.fail('no notifications expected'),
    react: {
      Fragment: 'fragment',
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: Element['children']): Element =>
        ({ type, props: props ?? {}, children }),
      useRef: (value: unknown) => memo(() => ({ current: value }), []),
      useState: (initial: unknown) => {
        const { slot, update } = changed([]);
        if (update) slot.value = initial;
        return [slot.value, (value: unknown) => { slot.value = value; }];
      },
      useMemo: memo,
      useCallback: (fn: unknown, deps: readonly unknown[]) => memo(() => fn, deps),
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
        const { slot, update } = changed(deps);
        if (update) effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
      },
    },
    state: {
      host,
      chatWindow: { getSnapshot: () => ({ sessionId: 's', status: 'unavailable', hasMore: false, partial: false, messages: [] }), subscribe: () => () => {} },
      bindDraft: (draft: ModuleDraft) => draft,
      register: (registration: { create(): SpeechService }) => {
        service = registration.create();
        return { get: () => service };
      },
    },
  } as unknown as ModuleFrontendContext;
  const draft: ModuleDraft = {
    id: 'd', sessionId: 's', purpose: { kind: 'prompt' }, subscribe: () => () => {},
    getSnapshot: () => ({ text: '', revision: 0, pending: false, unconfirmed: false, retired: false, hasContent: false,
      blocks: leases ? [{ id: 'lease', reason: 'speech' }] : [] }),
    editText: () => assert.fail('no transcript expected'),
    editTextIfRevision: () => assert.fail('no transcript expected'),
    captureSend: () => {
      intents++;
      return { send: async () => assert.fail('incomplete transcription must not submit'), cancel() {} };
    },
    block: () => { leases++; return () => { leases--; }; },
  };
  const frontend = await activate(context);
  t.after(() => {
    try { for (const slot of slots.toReversed()) slot.cleanup?.(); service.dispose(); }
    finally { for (const restore of restoreGlobals) restore(); }
  });
  const input = frontend.components!.find(component => component.boundary === 'composerInput')!;
  const status = frontend.components!.find(component => component.boundary === 'composerEditor')!;
  assert.equal(input.boundary, 'composerInput');
  assert.equal(status.boundary, 'composerEditor');
  if (input.boundary !== 'composerInput' || status.boundary !== 'composerEditor') assert.fail('missing middleware');
  const Input = input.wrap(() => null) as unknown as (props: ComposerInputProps) => Element;
  const StatusEditor = status.wrap(() => null) as unknown as (props: { draft: ModuleDraft }) => Element;
  const Status = (StatusEditor({ draft }).children[0] as Element).type as (props: { id: string }) => Element | null;
  const editor = {
    ownerDocument: { activeElement: null as unknown },
    getBoundingClientRect: () => ({ left: 0, right: 200, top: 0, bottom: 80 }),
    selectionStart: 0, selectionEnd: 0,
    focus() { focuses++; this.ownerDocument.activeElement = this; },
  };
  const props: ComposerInputProps = {
    draft, operation: 'prompt', disabled: false, sendBlocked: false, value: '',
    onSubmit: () => assert.fail('never submit'), onChange() {},
  };
  let tree!: Element;
  const render = () => {
    cursor = 0;
    tree = Input(props);
    const base = (tree.children[0] as Element).children[0] as Element;
    (base.props.editorRef as (node: unknown) => void)(editor);
    for (const effect of effects) effect();
    effects = [];
    return Status({ id: draft.id });
  };
  assert.equal(render(), null);
  assert.equal(render(), null, 'render the target registered by the initial layout effect');
  const layer = (tree.children[0] as Element).children[1] as Element;
  let captured = false;
  const point = {
    pointerType, pointerId: 1, button: 0, isPrimary: true, clientX: 20, clientY: 20,
    currentTarget: {
      setPointerCapture() { captured = true; },
      hasPointerCapture: () => captured,
      releasePointerCapture() { captured = false; event('onLostPointerCapture'); },
    },
    nativeEvent: {}, preventDefault() {},
  };
  const event = (name: string, patch = {}) => {
    (layer.props[name] as (event: unknown) => void)({ ...point, ...patch });
    return render();
  };
  return {
    service, render, event, grant: () => grant(stream),
    holding: () => gesture.getSnapshot(),
    clickMic: () => { ((tree.children[1] as Element).props.onClick as () => void)(); return render(); },
    values: () => ({ captures, contexts, requests, trackStops, focuses, leases, intents, captured }),
  };
}

for (const pointerType of ['mouse', 'touch'] as const) {
  test(`${pointerType}: short press stays internal through down, threshold wait, release and click`, async t => {
    const f = await fixture(t, pointerType);
    const idle = f.service.getSnapshot();
    assert.equal(f.event('onPointerDown'), null, 'no mounted status row or live region on down');
    assert.equal(f.holding(), true, 'the real gesture is pending, not a stubbed idle render');
    assert.equal(f.service.getSnapshot(), idle, 'pending press does not publish speech state');
    t.mock.timers.tick(HOLD_DELAY - 1);
    assert.equal(f.render(), null);
    assert.equal(f.event('onPointerUp'), null);
    assert.equal(f.values().focuses, 0, 'release keeps the click target available');
    assert.equal(f.event('onClick'), null);
    assert.equal(f.values().focuses, 1, 'completed click focuses synchronously');
    t.mock.timers.tick(HOLD_DELAY + 1);
    assert.equal(f.render(), null);
    assert.deepEqual(f.values(), { captures: 0, contexts: 0, requests: 0, trackStops: 0, focuses: 1, leases: 0, intents: 0, captured: false });
  });

  test(`${pointerType}: threshold starts real permission feedback, recording and release`, async t => {
    const f = await fixture(t, pointerType);
    f.event('onPointerDown');
    t.mock.timers.tick(HOLD_DELAY);
    assert.equal(f.service.getSnapshot().phase, 'permission');
    assert.equal((f.render()!.children[1] as Element).children[0], '正在准备录音…');
    assert.equal(f.values().captures, 1);
    assert.equal(f.values().contexts, 1);
    assert.equal(f.values().requests, 1);
    f.grant(); await settle();
    assert.equal(f.service.getSnapshot().phase, 'recording');
    assert.equal((f.render()!.children[1] as Element).children[0], '正在录音');
    f.event('onPointerUp');
    assert.equal(f.service.getSnapshot().phase, 'stopping');
    assert.equal(f.values().intents, 1, 'only active release captures the original draft send intent');
    assert.equal(f.values().trackStops, 1);
    f.event('onClick');
    assert.equal(f.values().focuses, 0);
    f.service.clear(); await settle();
    assert.equal(f.render(), null);
    assert.equal(f.values().leases, 0);
    assert.equal(f.values().intents, 1, 'clear does not capture or dispatch another intent');
  });

  test(`${pointerType}: cancellation before and during permission never revives late media`, async t => {
    for (const started of [false, true]) {
      for (const reason of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture', 'onPointerMove']) {
        await t.test(`${reason}, started=${started}`, async t => {
          const f = await fixture(t, pointerType);
          f.event('onPointerDown');
          t.mock.timers.tick(started ? HOLD_DELAY : HOLD_DELAY - 1);
          const row = f.event(reason, reason === 'onPointerMove' ? { clientY: 20 - CANCEL_DISTANCE } : {});
          assert.equal(row, null);
          assert.equal(f.holding(), false);
          assert.equal(f.values().intents, 0);
          assert.equal(f.service.getSnapshot().phase, 'idle');
          f.grant(); await settle();
          t.mock.timers.tick(HOLD_DELAY + 1);
          assert.equal(f.render(), null);
          assert.equal(f.values().captures, Number(started));
          assert.equal(f.values().contexts, Number(started));
          assert.equal(f.values().requests, Number(started));
          assert.equal(f.values().trackStops, Number(started), 'late permission is released, never recorded');
          assert.equal(f.values().leases, 0);
          assert.equal(f.values().captured, false);
          assert.equal(f.values().focuses, 0);
        });
      }
    }
  });
}

test('microphone button still starts permission immediately without a pending hold', async t => {
  const f = await fixture(t, 'mouse');
  const row = f.clickMic()!;
  assert.equal((row.children[1] as Element).children[0], '正在准备录音…');
  assert.equal(f.service.getSnapshot().phase, 'permission');
  assert.equal(f.values().captures, 1);
  assert.equal(f.holding(), false);
  assert.equal(f.values().intents, 0);
  ((row.children[3] as Element).props.onClick as () => void)();
  f.grant(); await settle();
  assert.equal(f.render(), null);
  assert.equal(f.values().trackStops, 1);
});
