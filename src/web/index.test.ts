import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComposerInputProps, ModuleDraft, ModuleFrontendContext } from '@cockpit/module-api';
import { activate, composeEditorRef } from './index.ts';

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
  for (const patch of [{ chatWindowVersion: undefined }, { composerInputVersion: undefined }]) {
    assert.throws(() => activate({
      apiVersion: 2, uiVersion: 1, chatWindowVersion: 1, composerInputVersion: 1,
      state: { chatWindow: {}, bindDraft() {} }, ...patch,
    } as unknown as ModuleFrontendContext), /配套宿主/);
  }
});

test('input middleware preserves native textarea props and keeps decision microphones separate from feedback', async () => {
  type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
  const disposers: (() => void)[] = [];
  const effects: (() => void)[] = [];
  const host = { getSnapshot: () => ({ sessionId: 's', visible: true, connected: true }), subscribe: () => () => {} };
  const context = {
    apiVersion: 2, uiVersion: 1, chatWindowVersion: 1, composerInputVersion: 1,
    signal: new AbortController().signal, request: async () => { throw new Error('No HTTP from render'); }, report() {},
    react: {
      Fragment: 'fragment',
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }),
      useRef: () => ({ current: null }),
      useMemo: (factory: () => unknown) => factory(),
      useCallback: (fn: unknown) => fn,
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
      useLayoutEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) effects.push(cleanup); },
    },
    state: {
      host,
      chatWindow: { getSnapshot: () => ({ sessionId: 's', status: 'unavailable', hasMore: false, partial: false, messages: [] }), subscribe: () => () => {} },
      bindDraft: (draft: ModuleDraft) => draft,
      register: (registration: { create(): unknown; dispose(value: unknown): void }) => {
        const service = registration.create();
        disposers.push(() => registration.dispose(service));
        return { get: () => service };
      },
    },
  } as unknown as ModuleFrontendContext;
  const frontend = await activate(context);
  assert.deepEqual(frontend.writes, ['text']);
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
        getSnapshot: () => ({ text: '', revision: 0, pending: false, unconfirmed: false, hasContent: false, blocks: [] }),
        subscribe: () => () => {}, editText() {}, block: () => () => {},
      } as ModuleDraft;
      const sendBlocked = operation === 'ask' || operation === 'elicitation';
      const onPaste = () => {};
      const onKeyDown = () => {};
      const tree = Wrapped({
        draft, operation, disabled: false, sendBlocked, value: 'controlled',
        onPaste, onKeyDown, onSubmit: nativeSubmit, onChange: nativeTextChange,
        'aria-label': 'Native editor', className: 'native-editor', rows: 1,
      });
      const base = tree.children[0] as Element;
      assert.equal(base.type, Base);
      assert.equal(base.props.onSubmit, nativeSubmit);
      assert.equal(base.props.onChange, nativeTextChange);
      assert.equal(base.props.onPaste, onPaste);
      assert.equal(base.props.onKeyDown, onKeyDown);
      assert.equal(base.props.value, 'controlled');
      assert.equal(base.props['aria-label'], 'Native editor');
      assert.equal(base.props.className, 'native-editor');
      assert.equal(base.props.rows, 1);
      assert.equal(tree.children.length, 2, 'only actual Base and microphone, no panel or placeholder inside row');
      const mic = tree.children[1] as Element;
      assert.equal(mic.type, 'button'); assert.equal(mic.props.type, 'button');
      assert.equal(mic.props['aria-label'], '开始语音输入');
      assert.equal(mic.props.disabled, sendBlocked);
      effects.pop()!();
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
  } finally { for (const effect of effects) effect(); for (const dispose of disposers) dispose(); }
});
