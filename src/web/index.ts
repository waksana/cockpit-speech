import type { ActivateFrontend, ComposerInputProps } from '@cockpit/module-api';
import type { Ref } from 'react';
import { icons } from './icons.ts';
import { prepareRecording } from './recorder.ts';
import { SpeechService } from './speech.ts';
import { readinessClient, transcriptionClient } from './transport.ts';

export function composeEditorRef(local: { current: HTMLTextAreaElement | null }, inherited?: Ref<HTMLTextAreaElement>): (node: HTMLTextAreaElement | null) => void | (() => void) {
  return node => {
    local.current = node;
    if (typeof inherited === 'function') {
      const cleanup = inherited(node);
      if (typeof cleanup === 'function') return () => { local.current = null; cleanup(); };
    } else if (inherited) inherited.current = node;
  };
}

export const activate: ActivateFrontend = context => {
  if (context.apiVersion !== 2 || context.uiVersion !== 1 || context.chatWindowVersion !== 1
    || context.composerInputVersion !== 1 || !context.state?.chatWindow || !context.state.bindDraft) {
    throw new Error('语音模块需要前端 API v2、UI v1、chatWindow v1 和 composerInput v1，请先升级配套宿主。');
  }
  const React = context.react;
  const h = React.createElement;
  const speech = context.state.register({
    id: 'speech',
    create: () => new SpeechService({
      signal: context.signal, host: context.state.host, chatWindow: context.state.chatWindow,
      prepare: prepareRecording, ready: readinessClient(context.request),
      transcribe: transcriptionClient(context.request), report: context.report,
    }),
    dispose: service => service.dispose(),
  }).get();
  function Icon({ name }: { name: keyof typeof icons }) {
    return h('svg', { className: 'ck-icon', width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, ...icons[name].map(([tag, attrs], key) => h(tag, { ...attrs, key })));
  }
  function SpeechPanel() {
    const state = React.useSyncExternalStore(speech.subscribe, speech.getSnapshot);
    React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
    const active = state.phase !== 'idle';
    const progress = state.phase === 'checking' ? '正在检查语音配置…'
      : state.phase === 'permission' ? '等待麦克风权限…'
        : state.phase === 'recording' ? '正在录音，点击停止后转写；两分钟后自动停止并转写。'
          : state.phase === 'stopping' ? '正在整理录音…' : state.phase === 'transcribing' ? '正在通过 Azure Speech 转写…' : state.notice;
    const recovery = state.recovery;
    return (active || state.error || state.notice || recovery) ? h('section', { className: 'cockpit-speech-panel', 'aria-label': '语音输入' },
      state.error ? h('p', { role: 'alert' }, state.error) : null,
      progress ? h('p', { role: 'status', 'aria-live': 'polite' }, progress) : null,
      active ? h('button', { type: 'button', className: 'ck-button', onClick: () => { speech.cancel(); speech.focusTarget(); } }, '取消语音输入') : null,
      recovery ? h(React.Fragment, null,
        h('label', null, '识别结果（未发送）', h('textarea', { className: 'ck-input', value: recovery.text, readOnly: true, rows: 4 })),
        h('div', { className: 'cockpit-speech-recovery-actions' },
          h('button', { type: 'button', className: 'ck-button', onClick: () => {
            void (async () => {
              try { await navigator.clipboard.writeText(recovery.text); }
              catch { speech.notifyCopyFailure(); }
            })();
          } }, '复制文字'),
          h('button', { type: 'button', className: 'ck-button', disabled: !speech.canInsert(), onClick: () => speech.insertRecovery() }, '插入原输入框光标处'),
        ),
      ) : null,
      !active ? h('button', { type: 'button', className: 'ck-button', onClick: () => { speech.dismiss(); speech.focusTarget(); } }, recovery ? '丢弃识别结果' : '关闭提示') : null,
    ) : null;
  }
  return {
    apiVersion: 2,
    writes: ['text'],
    components: [{
      id: 'speech-input', boundary: 'composerInput',
      wrap: Base => function SpeechInput(props: ComposerInputProps) {
        const draft = context.state.bindDraft(props.draft);
        const input = React.useRef<HTMLTextAreaElement | null>(null);
        const ref = React.useMemo(() => composeEditorRef(input, props.editorRef), [props.editorRef]);
        const state = React.useSyncExternalStore(speech.subscribe, speech.getSnapshot);
        const snapshot = React.useSyncExternalStore(draft.subscribe.bind(draft), draft.getSnapshot.bind(draft));
        React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
        const selection = React.useCallback(() => ({
          start: input.current?.selectionStart ?? draft.getSnapshot().text.length,
          end: input.current?.selectionEnd ?? draft.getSnapshot().text.length,
        }), [draft]);
        React.useLayoutEffect(() => {
          speech.setTarget({ draft, disabled: props.disabled, sendBlocked: props.sendBlocked, selection });
          return () => speech.clearTarget(draft.id);
        }, [draft, props.disabled, props.sendBlocked, selection]);
        React.useLayoutEffect(() => {
          const focus = state.focus;
          if (!focus || focus.id !== draft.id || focus.revision !== snapshot.revision || props.disabled) return;
          input.current?.focus();
          input.current?.setSelectionRange(focus.selection.start, focus.selection.end);
        }, [state.focus, draft.id, snapshot.revision, props.disabled]);
        const active = state.phase !== 'idle';
        const label = state.phase === 'recording' ? '停止录音并转写'
          : active ? '取消语音输入' : '开始语音输入';
        const disabled = !active && (props.disabled || props.sendBlocked || !speech.canStart());
        const button = h('button', {
          type: 'button', className: 'ck-icon-button cockpit-speech-mic', disabled,
          'aria-label': label, title: label, 'aria-pressed': active,
          onClick: () => {
            if (state.phase === 'recording') void speech.stop();
            else if (active) { speech.cancel(); speech.focusTarget(); }
            else void speech.start();
          },
        }, h(Icon, { name: active ? 'square' : 'mic' }));
        return h(React.Fragment, null,
          h(Base, { ...props, editorRef: ref }), button,
        );
      },
    }, {
      id: 'speech-feedback', boundary: 'composer',
      wrap: Base => function SpeechComposer(props) {
        React.useSyncExternalStore(props.draft.subscribe, props.draft.getSnapshot);
        return h(React.Fragment, null, h(Base, props), h(SpeechPanel));
      },
    }],
  };
};
