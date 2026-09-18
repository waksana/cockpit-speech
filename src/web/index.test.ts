import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComposerEditorProps, ModuleDraft, ModuleFrontendContext } from '@cockpit/module-api';
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
  for (const patch of [{ chatWindowVersion: undefined }, { composerActionsVersion: undefined }]) {
    assert.throws(() => activate({
      apiVersion: 2, uiVersion: 1, chatWindowVersion: 1, composerActionsVersion: 1,
      state: { chatWindow: {}, bindDraft() {} }, ...patch,
    } as unknown as ModuleFrontendContext), /配套宿主/);
  }
});

test('editor middleware preserves inherited native props/actions/children and keeps decision microphones visible', async () => {
  type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
  const disposers: (() => void)[] = [];
  const effects: (() => void)[] = [];
  const host = { getSnapshot: () => ({ sessionId: 's', visible: true, connected: true }), subscribe: () => () => {} };
  const context = {
    apiVersion: 2, uiVersion: 1, chatWindowVersion: 1, composerActionsVersion: 1,
    signal: new AbortController().signal, request: async () => { throw new Error('No HTTP from render'); }, report() {},
    react: {
      Fragment: 'fragment',
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }),
      useRef: () => ({ current: null }),
      useMemo: (factory: () => unknown) => factory(),
      useCallback: (fn: unknown) => fn,
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
      useLayoutEffect: (effect: () => () => void) => effects.push(effect()),
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
  assert.equal(component.boundary, 'composerEditor');
  if (component.boundary !== 'composerEditor') assert.fail('wrong boundary');
  const Base = () => null;
  const Wrapped = component.wrap(Base) as unknown as (props: ComposerEditorProps) => Element;
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
      const inheritedActions = { sentinel: 'inherited-action' };
      const children = { sentinel: 'left-content' };
      const tree = Wrapped({
        draft, operation, disabled: false, busy: false, sendBlocked, children: children as never,
        actions: inheritedActions as never, onSubmit: nativeSubmit, onTextChange: nativeTextChange,
      });
      const base = tree.children[0] as Element;
      assert.equal(base.type, Base);
      assert.equal(base.props.children, children);
      assert.equal(base.props.onSubmit, nativeSubmit);
      assert.equal(base.props.onTextChange, nativeTextChange);
      const actions = base.props.actions as Element;
      assert.equal(actions.children[0], inheritedActions);
      const mic = actions.children[1] as Element;
      assert.equal(mic.type, 'button'); assert.equal(mic.props.type, 'button');
      assert.equal(mic.props['aria-label'], '开始语音输入');
      assert.equal(mic.props.disabled, sendBlocked);
      effects.pop()!();
    }
  } finally { for (const effect of effects) effect(); for (const dispose of disposers) dispose(); }
});
