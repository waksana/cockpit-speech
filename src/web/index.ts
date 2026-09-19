import type { ActivateFrontend, ComposerInputProps } from '@cockpit/module-api';
import type { Ref } from 'react';
import { HoldGesture } from './hold.ts';
import { icons } from './icons.ts';
import { prepareRecording } from './recorder.ts';
import { SpeechService } from './speech.ts';
import { sessionClient } from './transport.ts';

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
      prepare: prepareRecording, session: sessionClient(context.request, context.signal), report: context.report,
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
    const active = state.phase !== 'idle' && state.phase !== 'retry';
    const recovery = state.recovery;
    return (!active && recovery) ? h('section', { className: 'cockpit-speech-panel', 'aria-label': '识别结果恢复' },
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
        const [focused, setFocused] = React.useState(false);
        const latest = React.useRef(props);
        latest.current = props;
        const ref = React.useMemo(() => composeEditorRef(input, props.editorRef), [props.editorRef]);
        const state = React.useSyncExternalStore(speech.subscribe, speech.getSnapshot);
        const snapshot = React.useSyncExternalStore(draft.subscribe.bind(draft), draft.getSnapshot.bind(draft));
        const host = React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
        const gesture = React.useMemo(() => new HoldGesture({
          allowed: () => !latest.current.disabled && !latest.current.sendBlocked && latest.current.value === ''
            && draft.getSnapshot().text === '' && !!input.current && input.current.ownerDocument.activeElement !== input.current
            && speech.canStart(),
          bounds: () => input.current?.getBoundingClientRect(),
          phase: () => speech.getSnapshot().phase,
          start: () => { void speech.start('hold'); },
          stop: () => { void speech.stop(); },
          cancel: () => speech.cancel(),
          focus: () => input.current?.focus(),
        }), [draft]);
        const holding = React.useSyncExternalStore(gesture.subscribe, gesture.getSnapshot);
        React.useLayoutEffect(() => {
          const cancel = gesture.cancel;
          const visibility = () => { if (document.visibilityState !== 'visible') cancel(); };
          window.addEventListener('blur', cancel);
          window.addEventListener('pagehide', cancel);
          window.addEventListener('resize', cancel);
          window.addEventListener('scroll', cancel, { capture: true });
          document.addEventListener('visibilitychange', visibility);
          return () => {
            cancel();
            window.removeEventListener('blur', cancel);
            window.removeEventListener('pagehide', cancel);
            window.removeEventListener('resize', cancel);
            window.removeEventListener('scroll', cancel, { capture: true });
            document.removeEventListener('visibilitychange', visibility);
          };
        }, [gesture]);
        React.useLayoutEffect(() => {
          if (focused || props.value !== '' || snapshot.text !== '' || props.disabled || props.sendBlocked
            || !host.visible || !host.connected || host.sessionId !== draft.sessionId) gesture.cancel();
        }, [gesture, focused, props.value, snapshot.text, props.disabled, props.sendBlocked, host, draft.sessionId]);
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
        const retry = state.phase === 'retry';
        const active = state.phase !== 'idle' && !retry;
        const busy = active && state.phase !== 'recording';
        const label = state.phase === 'recording' ? (state.holdingAtLimit ? '录音已达两分钟，松手转写' : '停止录音并转写')
          : state.phase === 'permission' ? '正在启动麦克风'
              : state.phase === 'stopping' ? '正在提交录音'
                : state.phase === 'transcribing' ? '正在转写录音'
                  : retry ? `语音失败，点击重试。${state.error ?? ''}` : '开始语音输入';
        const disabled = busy || (!active && (props.disabled || props.sendBlocked || !(retry ? speech.canRetry() : speech.canStart())));
        const button = h('button', {
          type: 'button', className: `ck-icon-button cockpit-speech-mic${retry ? ' cockpit-speech-retry' : ''}`, disabled,
          'aria-label': label, title: state.error ?? label, 'aria-pressed': state.phase === 'recording', 'aria-busy': busy,
          onClick: () => {
            gesture.cancel();
            if (state.phase === 'recording') void speech.stop();
            else if (retry) void speech.retry();
            else if (!busy) void speech.start();
          },
        }, busy ? h('span', { className: 'cockpit-speech-spinner', 'aria-hidden': true }) : h(Icon, { name: retry ? 'retry' : active ? 'square' : 'mic' }));
        const showGesture = holding || (!focused && props.value === '' && snapshot.text === ''
          && !props.disabled && !props.sendBlocked && speech.canStart());
        return h(React.Fragment, null,
          h('div', { className: 'cockpit-speech-input' },
            h(Base, { ...props, editorRef: ref,
              onFocus: event => { setFocused(true); gesture.cancel(); props.onFocus?.(event); },
              onBlur: event => { setFocused(false); props.onBlur?.(event); },
            }),
            showGesture ? h('div', {
              className: 'cockpit-speech-hold', 'aria-hidden': true,
              onPointerDown: event => { if (gesture.down(event, event.currentTarget)) event.preventDefault(); },
              onPointerMove: event => {
                for (const point of event.nativeEvent.getCoalescedEvents?.() ?? []) gesture.move(point);
                gesture.move(event);
              },
              onPointerUp: event => { gesture.up(event); },
              onPointerCancel: event => { gesture.lost(event.pointerId); },
              onLostPointerCapture: event => { gesture.lost(event.pointerId); },
              onContextMenu: event => event.preventDefault(),
              onClick: event => event.preventDefault(),
            }, '轻点输入，按住说话') : null,
          ), button,
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
