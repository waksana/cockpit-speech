import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComposerInputProps, ModuleDraft, ModuleFrontendContext } from '@cockpit/module-api';
import { activate, composeEditorRef } from './index.ts';
import type { SpeechService, SpeechSnapshot } from './speech.ts';
import { HoldGesture } from './hold.ts';

test('editor refs preserve object refs, callback nulls and React 19 cleanup', () => {
  const node = {} as HTMLTextAreaElement;
  const local = { current: null as HTMLTextAreaElement | null };
  const inherited = { current: null as HTMLTextAreaElement | null };
  const ref = composeEditorRef(local, inherited);
  ref(node); assert.equal(local.current, node); assert.equal(inherited.current, node);
  ref(null); assert.equal(local.current, null); assert.equal(inherited.current, null);
  const calls: (HTMLTextAreaElement | null)[] = [];
  const callback = composeEditorRef(local, value => { calls.push(value); });
  callback(node); callback(null); assert.deepEqual(calls, [node, null]);
  let cleaned = 0;
  const modern = composeEditorRef(local, () => () => { cleaned++; });
  const cleanup = modern(node);
  assert.equal(typeof cleanup, 'function');
  if (cleanup) cleanup();
  assert.equal(cleaned, 1); assert.equal(local.current, null);
});
test('frontend requires additive capabilities rather than assuming them from API v2', () => {
  for (const patch of [{ chatWindowVersion: undefined }, { composerInputVersion: undefined }, { draftLifecycleVersion: undefined }, { draftSubmissionVersion: undefined }]) {
    assert.throws(() => activate({
      apiVersion: 2, uiVersion: 1, chatWindowVersion: 1, composerInputVersion: 1, draftLifecycleVersion: 1, draftSubmissionVersion: 1,
      state: { chatWindow: {}, bindDraft() {} }, ...patch,
    } as unknown as ModuleFrontendContext), /配套宿主/);
  }
});

test('input middleware preserves native textarea props and keeps decision microphones separate from feedback', async t => {
  type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
  const disposers: (() => void)[] = [];
  const effects: (() => void)[] = [];
  let service!: SpeechService;
  let phase: SpeechSnapshot['phase'] = 'idle';
  let error: string | null = null;
  let sendOutcome: SpeechSnapshot['sendOutcome'] = null;
  let recovery: SpeechSnapshot['recovery'] = null;
  let holding = false;
  let focused = false;
  let level = 0;
  let onGesture: ((gesture: HoldGesture) => void) | undefined;
  for (const key of ['window', 'document']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: new EventTarget() });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  const cleanupEffects = () => { for (const cleanup of effects.splice(0).reverse()) cleanup(); };
  const host = { getSnapshot: () => ({ sessionId: 's', visible: true, connected: true }), subscribe: () => () => {} };
  const context = {
    apiVersion: 2, uiVersion: 1, chatWindowVersion: 1, composerInputVersion: 1, draftLifecycleVersion: 1, draftSubmissionVersion: 1,
    signal: new AbortController().signal, request: async () => { throw new Error('No HTTP from render'); }, report() {},
    createPortal: () => assert.fail('recording feedback must stay in normal component flow'),
    react: {
      Fragment: 'fragment',
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }),
      useRef: (value: unknown) => ({ current: value }),
      useState: () => [focused, () => {}],
      useMemo: (factory: () => unknown) => {
        const value = factory();
        if (value instanceof HoldGesture) onGesture?.(value);
        return value;
      },
      useCallback: (fn: unknown) => fn,
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => {
        const value = snapshot();
        return value && typeof value === 'object' && 'phase' in value ? { ...value, phase, error, level, sendOutcome, recovery }
          : typeof value === 'boolean' ? holding : value;
      },
      useLayoutEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) effects.push(cleanup); },
    },
    state: {
      host,
      chatWindow: { getSnapshot: () => ({ sessionId: 's', status: 'unavailable', hasMore: false, partial: false, messages: [] }), subscribe: () => () => {} },
      bindDraft: (draft: ModuleDraft) => draft,
      register: (registration: { create(): SpeechService; dispose(value: SpeechService): void }) => {
        service = registration.create();
        disposers.push(() => registration.dispose(service));
        return { get: () => service };
      },
    },
  } as unknown as ModuleFrontendContext;
  const frontend = await activate(context);
  assert.deepEqual(frontend.writes, ['text']);
  assert.deepEqual(frontend.sends, ['draft']);
  assert.equal(frontend.menus, undefined);
  const component = frontend.components![0]!;
  assert.equal(component.boundary, 'composerInput');
  if (component.boundary !== 'composerInput') assert.fail('wrong boundary');
  const Base = () => null;
  const Wrapped = component.wrap(Base) as unknown as (props: ComposerInputProps) => Element;
  try {
    for (const operation of ['prompt', 'ask', 'plan', 'elicitation'] as const) {
      const nativeSubmit = () => { throw new Error('Never submit from rendering'); };
      const nativeTextChange = () => {};
      const draft = {
        id: operation, sessionId: 's', purpose: operation === 'prompt' ? { kind: operation } : { kind: operation, requestId: 'request' },
        getSnapshot: () => ({ text: '', revision: 0, pending: false, unconfirmed: false, hasContent: false, blocks: [], retired: false }),
        subscribe: () => () => {}, editText() {}, editTextIfRevision: () => true, block: () => () => {},
        captureSend: () => { throw new Error('No send intent from rendering'); },
      } as ModuleDraft;
      const sendBlocked = operation === 'ask' || operation === 'elicitation';
      const onPaste = () => {};
      const onKeyDown = () => {};
      let focuses = 0;
      let blurs = 0;
      const tree = Wrapped({
        draft, operation, disabled: false, sendBlocked, value: 'controlled',
        onPaste, onKeyDown, onSubmit: nativeSubmit, onChange: nativeTextChange,
        onFocus: () => { focuses++; }, onBlur: () => { blurs++; },
        'aria-label': 'Native editor', className: 'native-editor', rows: 1, placeholder: 'Native placeholder',
      });
      const inputRegion = tree.children[0] as Element;
      assert.equal(inputRegion.props.className, 'cockpit-speech-input');
      const base = inputRegion.children[0] as Element;
      assert.equal(inputRegion.children[1], null, 'content keeps native editing without a gesture layer');
      assert.equal(base.type, Base);
      assert.equal(base.props.onSubmit, nativeSubmit);
      assert.equal(base.props.onChange, nativeTextChange);
      assert.equal(base.props.onPaste, onPaste);
      assert.equal(base.props.onKeyDown, onKeyDown);
      assert.equal(base.props.value, 'controlled');
      assert.equal(base.props['aria-label'], 'Native editor');
      assert.equal(base.props.className, 'native-editor');
      assert.equal(base.props.rows, 1);
      assert.equal(base.props.placeholder, 'Native placeholder');
      (base.props.onFocus as (event: object) => void)({});
      (base.props.onBlur as (event: object) => void)({});
      assert.equal(focuses, 1); assert.equal(blurs, 1);
      assert.equal(tree.children.length, 2, 'only input region and microphone; no full-screen feedback');
      const mic = tree.children[1] as Element;
      assert.equal(mic.type, 'button'); assert.equal(mic.props.type, 'button');
      assert.equal(mic.props['aria-label'], '开始语音输入');
      assert.equal(mic.props.disabled, sendBlocked);
      cleanupEffects();
      const empty = Wrapped({ draft, operation, disabled: false, sendBlocked, value: '', placeholder: 'Native placeholder', onSubmit: nativeSubmit, onChange: nativeTextChange });
      const layer = (empty.children[0] as Element).children[1] as Element | null;
      assert.equal(!!layer, !sendBlocked, 'only writable empty inputs offer a gesture');
      assert.equal(((empty.children[0] as Element).children[0] as Element).props.placeholder,
        layer ? '' : 'Native placeholder', 'hide the native hint only while the transparent gesture layer supplies it');
      if (layer) {
        assert.equal(layer.props['aria-hidden'], true);
        assert.equal(layer.props.tabIndex, undefined, 'keyboard focus stays on the real textarea');
        let nativeFocus = 0;
        const editor = { ownerDocument: { activeElement: null },
          getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 50 }),
          focus: () => { nativeFocus++; } };
        const emptyBase = (empty.children[0] as Element).children[0] as Element;
        (emptyBase.props.editorRef as (node: typeof editor) => void)(editor);
        let captured = false;
        const event = { pointerId: 1, clientX: 20, clientY: 20, button: 0, isPrimary: true,
          currentTarget: { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured,
            releasePointerCapture: () => { captured = false; } },
          preventDefault() {} };
        (layer.props.onPointerDown as (value: typeof event) => void)(event);
        (layer.props.onPointerUp as (value: typeof event) => void)(event);
        assert.equal(nativeFocus, 0, 'pointerup must leave the touch target mounted');
        (layer.props.onClick as (value: typeof event) => void)(event);
        assert.equal(nativeFocus, 1, 'the completed click focuses the original editor synchronously');
        (layer.props.onClick as (value: typeof event) => void)(event);
        assert.equal(nativeFocus, 1, 'the tap is consumed exactly once');
      }
      cleanupEffects();
      focused = true;
      const editing = Wrapped({ draft, operation, disabled: false, sendBlocked: false, value: '', placeholder: 'Native placeholder', onSubmit: nativeSubmit, onChange: nativeTextChange });
      const editingRegion = editing.children[0] as Element;
      assert.equal(editingRegion.children[1], null);
      assert.equal((editingRegion.children[0] as Element).props.placeholder, 'Native placeholder', 'focus restores the native hint');
      focused = false;
      cleanupEffects();
      holding = true; phase = 'recording';
      const ownership = t.mock.method(service, 'ownsDraft', () => true);
      let cancellations = 0;
      onGesture = gesture => { t.mock.method(gesture, 'interrupt', () => { cancellations++; }); };
      const streaming = Wrapped({ draft, operation, disabled: false, sendBlocked: false, value: 'live transcript', onSubmit: nativeSubmit, onChange: nativeTextChange });
      assert.equal(cancellations, 0, 'owned live text cannot cancel the ongoing hold');
      const heldLayer = (streaming.children[0] as Element).children[1] as Element;
      assert.equal(heldLayer.children[0], '', 'keep pointer capture without drawing the hint over live text');
      cleanupEffects();
      ownership.mock.mockImplementation(() => false);
      const before = cancellations;
      Wrapped({ draft, operation, disabled: false, sendBlocked: false, value: 'external edit', onSubmit: nativeSubmit, onChange: nativeTextChange });
      assert.equal(cancellations, before + 1, 'external changes interrupt a hold without discarding its audio');
      cleanupEffects(); ownership.mock.restore(); onGesture = undefined;
      holding = false; phase = 'idle';
      for (const current of ['permission', 'recording', 'stopping', 'transcribing', 'retry', 'sending', 'send-error'] as const) {
        phase = current;
        holding = true;
        const rendered = Wrapped({ draft, operation, disabled: false, sendBlocked: false, value: '', onSubmit: nativeSubmit, onChange: nativeTextChange });
        const button = rendered.children[1] as Element;
        const busy = current !== 'recording' && current !== 'retry' && current !== 'send-error';
        assert.equal(button.props.disabled, busy || current === 'retry' || current === 'send-error');
        assert.equal(button.props['aria-busy'], busy);
        assert.equal(button.props['aria-pressed'], current === 'recording');
        assert.notEqual(button.props['aria-label'], '取消语音输入');
        const icon = button.children[0] as Element;
        assert.equal(icon.type === 'span', busy);
        if (busy) {
          assert.equal(icon.props.className, 'cockpit-speech-spinner');
          (button.props.onClick as () => void)();
          assert.equal(service.getSnapshot().phase, 'idle', 'busy clicks neither cancel nor start');
        }
        assert.equal(rendered.children.length, 2, 'input wrapper does not insert status inside the editing row');
        if (current === 'recording') {
          assert.equal(icon.props.name, 'stop');
          assert.equal(icon.props.className, 'ck-icon-md cockpit-speech-stop');
          for (const held of [true, false]) {
            holding = held; level = 1;
            const loud = Wrapped({ draft, operation, disabled: false, sendBlocked: false, value: '', onSubmit: nativeSubmit, onChange: nativeTextChange });
            const stop = (loud.children[1] as Element).children[0] as Element;
            assert.equal(stop.props.name, 'stop');
            assert.equal(stop.props.style, undefined, 'volume never scales the stop control');
            cleanupEffects();
          }
          level = 0;
        }
        holding = false;
        cleanupEffects();
      }
      phase = 'idle';
    }
    const feedback = frontend.components![1]!;
    assert.equal(feedback.boundary, 'composer');
    if (feedback.boundary !== 'composer') assert.fail('wrong feedback boundary');
    const Composer = feedback.wrap(Base) as unknown as (props: { draft: ModuleDraft; children: unknown }) => Element;
    const props = { draft: { subscribe() {}, getSnapshot() {} } as unknown as ModuleDraft, children: 'native context' };
    const tree = Composer(props);
    assert.equal((tree.children[0] as Element).type, Base);
    assert.equal((tree.children[0] as Element).props, props);
    assert.equal(typeof (tree.children[1] as Element).type, 'function', 'feedback follows the whole composer');
    const PanelComponent = (tree.children[1] as Element).type as (props: { id: string }) => Element | null;
    const Panel = () => PanelComponent({ id: 'prompt' });
    for (const current of ['permission', 'recording', 'stopping', 'transcribing', 'retry', 'sending', 'send-error'] as const) {
      phase = current;
      assert.equal(Panel(), null, 'no phase text, timer or cancel panel');
    }
    phase = 'idle'; error = 'Synthetic device disconnected';
    assert.equal(Panel(), null, 'errors never create a notification bar');
    const status = frontend.components![2]!;
    assert.equal(status.boundary, 'composerEditor');
    if (status.boundary !== 'composerEditor') assert.fail('wrong status boundary');
    const StatusEditor = status.wrap(Base) as unknown as (value: typeof props) => Element;
    const statusTree = StatusEditor(props);
    assert.equal(statusTree.props.className, 'cockpit-speech-editor');
    assert.equal((statusTree.children[1] as Element).type, Base);
    const StatusComponent = (statusTree.children[0] as Element).type as (props: { id: string }) => Element | null;
    const Status = () => StatusComponent({ id: 'prompt' });
    assert.equal(Status(), null);
    for (const current of ['permission', 'recording', 'stopping', 'transcribing', 'retry', 'sending', 'send-error'] as const) {
      phase = current;
      const row = Status()!;
      assert.match(String(row.props.className), /ck-input-status ck-status-text/);
      const marker = row.children[0] as Element;
      const symbol = marker.children[0] as Element;
      const pending = ['permission', 'stopping', 'transcribing', 'sending'].includes(current);
      assert.equal(symbol.props.className, pending ? 'cockpit-speech-spinner cockpit-speech-status-spinner'
        : current === 'recording' ? 'cockpit-speech-level' : 'cockpit-speech-status-icon');
      assert.equal(!!row.children[2], current === 'recording', 'time is only shown during recording');
      assert.equal(!!row.children[3], current !== 'recording', 'pending/error states can be cleared');
      assert.equal(row.children.length, 4, 'retry stays in the microphone button');
      if (current === 'retry') {
        ((row.children[3] as Element).props.onClick as () => void)();
        assert.equal(service.getSnapshot().phase, 'idle');
      }
    }
    phase = 'send-error'; sendOutcome = 'unconfirmed';
    recovery = { id: 'prompt', sessionId: 's', purpose: 'prompt', text: 'synthetic message' };
    error = '发送结果未确认，可能已提交；不会自动重发。';
    const unknown = Panel()!;
    const recovered = unknown.children[0] as Element;
    assert.equal((recovered.children[1] as Element).children[0], '识别结果（发送状态未确认）');
    const statusRow = Status()!;
    assert.equal((statusRow.children[1] as Element).children[0], error);
    assert.match(String((statusRow.children[3] as Element).props.title), /不会撤回/);
  } finally { cleanupEffects(); for (const dispose of disposers) dispose(); }
});
