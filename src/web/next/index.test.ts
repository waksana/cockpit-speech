import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import type { ModuleNextFrontendContext } from '@cockpit/module-api';
import { activate } from './index.ts';
import type { SpeechService, SpeechSnapshot } from '../speech.ts';

type Element = { type: unknown; props: Record<string, unknown>; children: (Element | string | null)[] };
function all(element: Element): Element[] {
  return [element, ...element.children.flatMap(child => child && typeof child !== 'string' ? all(child) : [])];
}
function text(element: Element): string {
  return element.children.map(child => typeof child === 'string' ? child : child ? text(child) : '').join('');
}

test('next presentation rejects absent public UI independently of classic capabilities', () => {
  for (const ui of [undefined, { version: 0 }, { version: 1, Button: () => null }]) {
    assert.throws(() => activate({ ui, uiVersion: 1, uiSurfaceVersion: 1 } as unknown as ModuleNextFrontendContext), /公共组件 v1/);
  }
});

test('next feedback uses host components, explicit recovery actions and polite phase-only announcements', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => originalWindow ? Object.defineProperty(globalThis, 'window', originalWindow) : Reflect.deleteProperty(globalThis, 'window'));
  const controller = new AbortController();
  let speech!: SpeechService;
  const ui = { version: 1, Button: () => null, Label: () => null, Textarea: () => null,
    Alert: () => null, AlertTitle: () => null, AlertDescription: () => null };
  const context = {
    apiVersion: 2, chatWindowVersion: 1, composerInputVersion: 1, draftLifecycleVersion: 1, draftSubmissionVersion: 1,
    ui, signal: controller.signal, request: () => assert.fail('render cannot request credentials'),
    report: () => assert.fail('no global notification'),
    react: {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: Element['children']): Element =>
        ({ type, props: props ?? {}, children }),
      useId: () => 'recovery-id',
      useState: () => [false, () => {}],
      useRef: (current: unknown) => ({ current }),
      useMemo: (factory: () => unknown) => factory(),
      useLayoutEffect() {},
      useCallback: (fn: unknown) => fn,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    },
    state: {
      host: { subscribe: () => () => {}, getSnapshot: () => ({ sessionId: 's', connected: true, visible: true }) },
      chatWindow: { subscribe: () => () => {}, getSnapshot: () => ({ status: 'unavailable', messages: [] }) },
      bindDraft: () => assert.fail('feedback must not bind or replace a draft'),
      register: (registration: { create(): SpeechService }) => {
        speech = registration.create(); return { get: () => speech };
      },
    },
  } as unknown as ModuleNextFrontendContext;
  const frontend = await activate(context);
  t.after(() => { controller.abort(); speech.dispose(); frontend.dispose?.(); });
  assert.deepEqual(frontend.writes, ['text']);
  assert.deepEqual(frontend.sends, ['draft']);
  assert.deepEqual(frontend.components?.map(component => component.boundary), ['composerInput', 'composerEditor']);
  const feedback = frontend.components![1]!;
  if (feedback.boundary !== 'composerEditor') assert.fail('wrong boundary');
  const Base = () => null;
  const Editor = feedback.wrap(Base) as unknown as (props: object) => Element;
  const props = { draft: { id: 'original' }, children: 'native editor', onSubmit: () => assert.fail('no native dispatch') };
  const composed = Editor(props);
  assert.equal((composed.children[0] as Element).type, Base);
  assert.equal((composed.children[0] as Element).props, props);
  const feedbackElement = composed.children[1] as Element;
  const Feedback = feedbackElement.type as (props: Record<string, unknown>) => Element | null;
  let state: SpeechSnapshot = speech.getSnapshot();
  const idle = state;
  t.mock.method(speech, 'getSnapshot', () => state);
  const render = () => Feedback(feedbackElement.props);
  assert.equal(render(), null);
  const retained = t.mock.method(speech, 'hasRetainedRecording', () => true);
  const retryable = t.mock.method(speech, 'canRetry', () => true);
  t.mock.method(speech, 'canInsert', () => false);
  const retried: string[] = [];
  const cleared: string[] = [];
  const inserted: string[] = [];
  t.mock.method(speech, 'retry', async (id: string) => { retried.push(id); });
  t.mock.method(speech, 'clear', (id: string) => { cleared.push(id); });
  t.mock.method(speech, 'insertRecovery', (id: string) => { inserted.push(id); });
  for (const phase of ['permission', 'recording', 'stopping', 'transcribing', 'sending', 'retry', 'send-error'] as const) {
    state = { ...idle, phase, elapsedSeconds: 17, level: 0.4,
      sendOutcome: phase === 'send-error' ? 'unconfirmed' : null };
    const row = render()!;
    assert.equal(row.type, ui.Alert);
    assert.equal(row.props.role, 'region');
    const live = all(row).find(element => element.props.role === 'status')!;
    assert.equal(live.props['aria-live'], 'polite');
    assert.doesNotMatch(text(live), /00:17/);
    assert.equal(all(live).some(element => element.props.className === 'csp-next-meter'), false);
    for (const button of all(row).filter(element => element.type === ui.Button)) assert.equal(button.props.type, 'button');
    if (phase === 'recording') {
      assert.match(text(row), /00:17/);
      assert.match(text(row), /停止只写入草稿/);
      assert.equal(all(row).find(element => text(element) === '取消本次语音' && element.type === ui.Button)?.props.disabled, undefined);
    }
    if (phase === 'retry') {
      const retry = all(row).find(element => element.type === ui.Button && text(element) === '重试录音')!;
      assert.equal(retry.props.disabled, false);
      (retry.props.onClick as () => void)();
      retryable.mock.mockImplementation(() => false);
      assert.equal(all(render()!).find(element => element.type === ui.Button && text(element) === '重试录音')?.props.disabled, true);
      retained.mock.mockImplementation(() => false);
      assert.match(text(render()!), /没有可重放的录音/);
      retained.mock.mockImplementation(() => true);
    }
    if (phase === 'sending' || phase === 'send-error') {
      assert.match(text(row), /不会撤回可能已经提交/);
      assert.equal(all(row).some(element => element.type === ui.Button && /重试|发送/.test(text(element))), false);
    }
  }
  assert.deepEqual(retried, ['original']);
  state = { ...idle, phase: 'retry', error: 'Synthetic recoverable error', notice: 'Keep this full notice.',
    recovery: { id: 'original', sessionId: 's', purpose: 'prompt', text: 'Long retained result\n'.repeat(80) } };
  const row = render()!;
  assert.match(text(row), /Synthetic recoverable error/);
  const result = all(row).find(element => element.type === ui.Textarea)!;
  assert.equal(result.props.value, state.recovery!.text);
  assert.equal(result.props.readOnly, true);
  assert.equal(all(row).find(element => element.type === ui.Label)?.props.htmlFor, result.props.id);
  const insertion = all(row).find(element => element.type === ui.Button && text(element) === '插入原草稿光标处')!;
  assert.equal(insertion.props.disabled, true);
  (insertion.props.onClick as () => void)();
  assert.deepEqual(inserted, ['original']);
  const clear = all(row).find(element => element.type === ui.Button && text(element) === '丢弃本次语音')!;
  (clear.props.onClick as () => void)();
  assert.deepEqual(cleared, ['original']);
  const copyFailed = t.mock.method(speech, 'notifyCopyFailure', () => {});
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try {
    const copy = all(row).find(element => element.type === ui.Button && text(element) === '复制文字')!;
    (copy.props.onClick as () => void)();
    await Promise.resolve();
    assert.equal(copyFailed.mock.calls.length, 1, 'missing clipboard support remains recoverable');
    assert.equal(copyFailed.mock.calls[0]!.arguments[0], 'original');
    assert.equal(copyFailed.mock.calls[0]!.arguments[1], state.recovery);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('classic and next keep independent presentation assets without global resets or host imports', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const next = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const classic = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../frontend.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /@import|@tailwind|:root|\bbody\b|\bhtml\b|\.ck-|--ck-|--host-|--chat-/);
  assert.doesNotMatch(next, /ck-|--ck-|@cockpit\/ui|from ['"]react['"]|from ['"]radix-ui['"]/);
  assert.doesNotMatch(classic + shared, /next\/|styles\.css|@cockpit\/ui/);
  assert.match(css, /prefers-reduced-motion/);
  const manifest = JSON.parse(await readFile(new URL('../../../cockpit.module.json', import.meta.url), 'utf8'));
  assert.equal(manifest.frontend.entry, 'dist/web/index.js');
  assert.deepEqual(manifest.frontend.styles, ['dist/web/styles.css']);
  assert.deepEqual(manifest.frontend.next, { entry: 'dist/web/next/index.js', styles: ['dist/web/next/styles.css'] });
});

test('retry focus survives pending work; focused retry/cancel/discard removal returns only to the same live composer', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'window', descriptor) : Reflect.deleteProperty(globalThis, 'window'));
  const controller = new AbortController();
  let service!: SpeechService;
  let retired = false;
  const host = { sessionId: 's', connected: true, visible: true };
  const slots: unknown[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const ref = (current: unknown) => {
    const index = cursor++;
    return slots[index] ?? (slots[index] = { current });
  };
  const memo = (factory: () => unknown) => {
    const index = cursor++;
    return slots[index] ?? (slots[index] = factory());
  };
  const context = {
    apiVersion: 2, chatWindowVersion: 1, composerInputVersion: 1, draftLifecycleVersion: 1, draftSubmissionVersion: 1,
    ui: { version: 1, Button: 'Button', Label: 'Label', Textarea: 'Textarea', Alert: 'Alert', AlertTitle: 'Title', AlertDescription: 'Description' },
    signal: controller.signal, request: () => assert.fail('focus must not acquire media or credentials'), report() {},
    state: {
      host: { subscribe: () => () => {}, getSnapshot: () => host },
      chatWindow: { subscribe: () => () => {}, getSnapshot: () => ({ status: 'unavailable', messages: [] }) },
      bindDraft() {},
      register: (registration: { create(): SpeechService }) => {
        service = registration.create(); return { get: () => service };
      },
    },
    react: {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: Element['children']): Element => ({ type, props: props ?? {}, children }),
      useId: () => 'focus-result', useCallback: (fn: unknown) => fn, useRef: ref, useMemo: memo,
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
      useLayoutEffect: (effect: () => void, dependencies?: unknown[]) => { if (!dependencies) effects.push(effect); },
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (next: unknown) => { slots[index] = next; }];
      },
    },
  } as unknown as ModuleNextFrontendContext;
  const frontend = await activate(context);
  t.after(() => { controller.abort(); service.dispose(); frontend.dispose?.(); });
  const middleware = frontend.components![1]!;
  if (middleware.boundary !== 'composerEditor') assert.fail('wrong boundary');
  const Editor = middleware.wrap(() => null) as unknown as (props: object) => Element;
  const draft = { id: 'original', sessionId: 's', getSnapshot: () => ({ retired }) };
  const tree = Editor({ draft });
  const child = tree.children[1] as Element;
  assert.equal(child.props.key, draft.id, 'replacement drafts remount the focus owner instead of redirecting it');
  const scope = child.props.scope as { current: object | null };
  const Feedback = child.type as (props: Record<string, unknown>) => Element | null;
  slots.length = 0;
  const document = { body: {}, documentElement: {}, activeElement: null as object | null,
    hasFocus: () => true, visibilityState: 'visible', querySelectorAll: () => [] };
  let focused = 0;
  const microphone = {
    ownerDocument: document, isConnected: true, disabled: false, matches: () => false,
    closest: () => null, getAttribute: () => null, checkVisibility: () => true, getClientRects: () => [{}],
    focus() { focused++; document.activeElement = microphone; },
  };
  scope.current = { querySelector: (selector: string) => selector === '.csp-next-mic' ? microphone : null };
  const idle = service.getSnapshot();
  let state: SpeechSnapshot = { ...idle, phase: 'retry', error: 'Retained synthetic recording' };
  t.mock.method(service, 'getSnapshot', () => state);
  t.mock.method(service, 'canRetry', () => state.phase === 'retry');
  t.mock.method(service, 'hasRetainedRecording', () => true);
  let resolveRetry!: () => void;
  let retries = 0;
  t.mock.method(service, 'retry', () => { retries++; return new Promise<void>(resolve => { resolveRetry = resolve; }); });
  t.mock.method(service, 'clear', () => { state = idle; });
  const render = () => { cursor = 0; return Feedback(child.props); };
  const flush = () => { for (const effect of effects.splice(0)) effect(); };
  const button = (row: Element, className: string) => all(row).find(element => element.props.className === className)!;
  const own = (element: Element) => {
    const node = { ownerDocument: document, isConnected: true };
    document.activeElement = node;
    const cleanup = (element.props.ref as (node: object) => () => void)(node);
    return () => { cleanup(); node.isConnected = false; document.activeElement = document.body; };
  };
  let row = render()!; flush();
  const retry = button(row, 'csp-next-retry');
  const removeRetry = own(retry);
  (retry.props.onClick as () => void)();
  state = { ...state, phase: 'transcribing' };
  row = render()!; flush();
  const pending = button(row, 'csp-next-retry');
  assert.equal(pending.props.ref, retry.props.ref, 'pending state does not detach the focused ref');
  assert.equal(pending.props.disabled, false, 'native disabling would drop pending focus');
  assert.equal(pending.props['aria-disabled'], true);
  assert.equal(pending.props['aria-busy'], true);
  assert.match(text(pending), /正在重试/);
  (pending.props.onClick as () => void)();
  assert.equal(retries, 1, 'focusability does not allow another retry');
  assert.equal(focused, 0);
  state = idle; resolveRetry(); await Promise.resolve();
  assert.equal(render(), null);
  removeRetry(); flush();
  assert.equal(focused, 1);
  assert.equal(document.activeElement, microphone);

  for (const phase of ['recording', 'retry', 'send-error'] as const) {
    for (const departure of ['none', 'editing', 'session', 'retired', 'disconnected'] as const) {
      state = { ...idle, phase };
      row = render()!; flush();
      const clear = button(row, 'csp-next-clear');
      const removeClear = own(clear);
      (clear.props.onClick as () => void)();
      assert.equal(render(), null);
      removeClear();
      const before: number = focused;
      if (departure === 'editing') document.activeElement = {};
      if (departure === 'session') host.sessionId = 'other';
      if (departure === 'retired') retired = true;
      if (departure === 'disconnected') host.connected = false;
      flush();
      assert.equal(focused, before + (departure === 'none' ? 1 : 0), `${phase}: ${departure}`);
      host.sessionId = 's'; host.connected = true; retired = false;
    }
  }
  state = { ...idle, phase: 'retry' };
  row = render()!; flush();
  (button(row, 'csp-next-retry').props.onClick as () => void)();
  const oldRetry = resolveRetry;
  row = render()!; flush();
  (button(row, 'csp-next-clear').props.onClick as () => void)();
  assert.equal(render(), null); flush();
  state = { ...idle, phase: 'retry' };
  row = render()!; flush();
  (button(row, 'csp-next-retry').props.onClick as () => void)();
  oldRetry(); await Promise.resolve();
  row = render()!; flush();
  assert.equal(button(row, 'csp-next-retry').props['aria-busy'], true, 'late cleared retry cannot release a newer focus owner');
  resolveRetry(); await Promise.resolve();
});
