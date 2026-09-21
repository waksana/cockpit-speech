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
  const Feedback = (composed.children[1] as Element).type as (props: { id: string }) => Element | null;
  let state: SpeechSnapshot = speech.getSnapshot();
  const idle = state;
  t.mock.method(speech, 'getSnapshot', () => state);
  const render = () => Feedback({ id: 'original' });
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
