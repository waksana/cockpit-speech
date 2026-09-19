import type { ActivateFrontend, ComposerInputProps } from '@cockpit/module-api';
import type { Ref } from 'react';
import { HoldGesture } from './hold.ts';
import { icons } from './icons.ts';
import { KeyboardHold } from './keyboard.ts';
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
    || context.composerInputVersion !== 1 || context.draftLifecycleVersion !== 1 || context.draftSubmissionVersion !== 1
    || !context.state?.chatWindow || !context.state.bindDraft) {
    throw new Error('语音模块需要前端 API v2、UI v1、chatWindow v1、composerInput v1、draftLifecycle v1 和 draftSubmission v1，请先升级配套宿主。');
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
  const keyboard = new KeyboardHold();
  const unsubscribeKeyboard = speech.subscribe(keyboard.refresh);
  context.signal.addEventListener('abort', () => { keyboard.dispose(); unsubscribeKeyboard(); }, { once: true });
  function Icon({ name, className = '' }: { name: keyof typeof icons; className?: string }) {
    return h('svg', { className: `ck-icon ${className}`, width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, ...icons[name].map(([tag, attrs], key) => h(tag, { ...attrs, key })));
  }
  function useSpeech(id: string) {
    const snapshot = React.useCallback(() => speech.getSnapshot(id), [id]);
    return React.useSyncExternalStore(speech.subscribe, snapshot);
  }
  function SpeechStatus({ id }: { id: string }) {
    const state = useSpeech(id);
    React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
    const preparing = state.phase === 'permission';
    if (state.phase === 'idle' && !state.recovery && !state.notice) return null;
    const recording = state.phase === 'recording';
    const capturing = recording && !state.holdingAtLimit;
    const processing = state.phase === 'stopping' || state.phase === 'transcribing' || state.phase === 'sending';
    const retry = state.phase === 'retry';
    const sendError = state.phase === 'send-error';
    const retryHint = speech.hasRetainedRecording(id)
      ? (speech.canRetry(id) ? '录音已保留，点击话筒重试。' : '录音已保留，当前无法重试，可清除后重新录音。')
      : '请点击话筒重新录音。';
    const status = sendError ? state.error!
      : retry ? `${state.error ?? '语音失败。'}${retryHint}`
      : preparing ? '正在准备录音…'
        : state.recovery ? '识别结果未写入草稿，请在下方恢复。'
          : recording ? (state.holdingAtLimit ? '已达两分钟' : '正在录音')
            : processing ? '正在处理录音…'
              : state.notice ?? '正在处理录音…';
    const label = (preparing || recording || processing) && state.notice ? `${status} ${state.notice}` : status;
    const time = `${String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0')}:${String(state.elapsedSeconds % 60).padStart(2, '0')}`;
    return h('div', { className: `ck-input-status ck-status-text cockpit-speech-status ${capturing || retry || sendError ? 'ck-danger' : 'ck-text-secondary'}` },
      h('span', { className: 'ck-status-marker', 'aria-hidden': true },
        preparing || processing ? h('span', { className: 'cockpit-speech-spinner cockpit-speech-status-spinner' })
          : capturing ? h('span', { className: 'cockpit-speech-level',
            style: { transform: `scale(${1 + Math.min(1, state.level * 6)})` } })
            : h(Icon, { name: state.holdingAtLimit ? 'pause' : 'error', className: 'cockpit-speech-status-icon' })),
      h('span', { className: 'ck-status-label', role: 'status', title: label }, label),
      recording ? h('span', { className: 'cockpit-speech-time', 'aria-label': `录音时长 ${state.elapsedSeconds} 秒` }, time) : null,
      !recording ? h('button', {
        type: 'button', className: 'ck-icon-button ck-status-action', 'aria-label': '清除本次语音',
        title: state.phase === 'sending' || state.sendOutcome === 'unconfirmed'
          ? '清除本地录音和结果，不会撤回可能已经提交的消息'
          : '清除本次录音、识别结果和错误，保留已有草稿', onClick: () => speech.clear(id),
      }, h(Icon, { name: 'close', className: 'ck-icon-sm' })) : null);
  }
  function SpeechPanel({ id }: { id: string }) {
    const state = useSpeech(id);
    React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
    const active = state.phase !== 'idle' && state.phase !== 'retry' && state.phase !== 'send-error';
    const recovery = state.recovery;
    return (!active && recovery) ? h('section', { className: 'cockpit-speech-panel', 'aria-label': '识别结果恢复' },
      recovery ? h(React.Fragment, null,
        state.error || state.notice ? h('p', { role: 'status' }, state.error ?? state.notice) : null,
        h('label', null, state.sendOutcome === 'unconfirmed' ? '识别结果（发送状态未确认）' : '识别结果（未发送）',
          h('textarea', { className: 'ck-input', value: recovery.text, readOnly: true, rows: 4 })),
        h('div', { className: 'cockpit-speech-recovery-actions' },
          h('button', { type: 'button', className: 'ck-button', onClick: () => {
            void (async () => {
              try { await navigator.clipboard.writeText(recovery.text); }
              catch { speech.notifyCopyFailure(id, recovery); }
            })();
          } }, '复制文字'),
          h('button', { type: 'button', className: 'ck-button', disabled: !speech.canInsert(id), onClick: () => speech.insertRecovery(id) }, '插入原输入框光标处'),
        ),
      ) : null,
      !active ? h('button', { type: 'button', className: 'ck-button', onClick: () => { speech.dismiss(id); speech.focusTarget(undefined, id); } }, recovery ? '丢弃识别结果' : '关闭提示') : null,
    ) : null;
  }
  return {
    apiVersion: 2,
    writes: ['text'],
    sends: ['draft'],
    components: [{
      id: 'speech-input', boundary: 'composerInput',
      wrap: Base => function SpeechInput(props: ComposerInputProps) {
        const draft = context.state.bindDraft(props.draft);
        const input = React.useRef<HTMLTextAreaElement | null>(null);
        const [focused, setFocused] = React.useState(false);
        const latest = React.useRef(props);
        latest.current = props;
        const ref = React.useMemo(() => composeEditorRef(input, props.editorRef), [props.editorRef]);
        const state = useSpeech(draft.id);
        const snapshot = React.useSyncExternalStore(draft.subscribe.bind(draft), draft.getSnapshot.bind(draft));
        const host = React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
        const gesture = React.useMemo(() => new HoldGesture({
          allowed: () => !latest.current.disabled && !latest.current.sendBlocked && latest.current.value === ''
            && draft.getSnapshot().text === '' && !!input.current && input.current.ownerDocument.activeElement !== input.current
            && speech.canStart(draft.id),
          bounds: () => input.current?.getBoundingClientRect(),
          phase: () => speech.getSnapshot(draft.id).phase,
          start: () => { void speech.start('hold', draft.id); },
          stop: () => { void speech.releaseHold(draft.id); },
          cancel: () => speech.cancel(draft.id),
          interrupt: () => speech.interrupt(draft.id),
          focus: () => input.current?.focus(),
        }), [draft]);
        const holding = React.useSyncExternalStore(gesture.subscribe, gesture.getSnapshot);
        React.useLayoutEffect(() => keyboard.register({
          editor: () => input.current,
          available: () => {
            const host = context.state.host.getSnapshot();
            return !latest.current.disabled && !latest.current.sendBlocked && host.visible && host.connected
              && host.sessionId === draft.sessionId && !draft.getSnapshot().retired;
          },
          empty: () => latest.current.value === '' && draft.getSnapshot().text === '' && input.current?.value === '',
          canStart: () => !gesture.getSnapshot() && speech.canStart(draft.id),
          canContinue: () => speech.ownsDraft(draft.id)
            || (latest.current.value === '' && draft.getSnapshot().text === '' && input.current?.value === ''),
          phase: () => speech.getSnapshot(draft.id).phase,
          start: () => { void speech.start('hold', draft.id, { focusOnCompletion: false }); },
          release: () => { void speech.releaseHold(draft.id); },
          interrupt: () => speech.interrupt(draft.id),
          cancel: () => speech.cancel(draft.id),
        }, document, window), [draft, gesture]);
        React.useLayoutEffect(keyboard.refresh, [props.value, props.disabled, props.sendBlocked, snapshot, host]);
        React.useLayoutEffect(() => {
          const interrupt = () => { gesture.interrupt(); speech.interrupt(draft.id); };
          const visibility = () => { if (document.visibilityState !== 'visible') interrupt(); };
          const keyboard = (event: KeyboardEvent) => {
            if (!gesture.getSnapshot()) return;
            if (event.key === 'Escape') gesture.cancel();
            if (event.key === 'Tab') interrupt();
          };
          window.addEventListener('blur', interrupt);
          window.addEventListener('pagehide', interrupt);
          window.addEventListener('resize', interrupt);
          window.addEventListener('keydown', keyboard);
          document.addEventListener('visibilitychange', visibility);
          return () => {
            interrupt();
            window.removeEventListener('blur', interrupt);
            window.removeEventListener('pagehide', interrupt);
            window.removeEventListener('resize', interrupt);
            window.removeEventListener('keydown', keyboard);
            document.removeEventListener('visibilitychange', visibility);
          };
        }, [gesture, draft.id]);
        React.useLayoutEffect(() => {
          if (focused || ((props.value !== '' || snapshot.text !== '') && !speech.ownsDraft(draft.id)) || props.disabled || props.sendBlocked
            || !host.visible || !host.connected || host.sessionId !== draft.sessionId) gesture.interrupt();
        }, [gesture, focused, props.value, snapshot.text, props.disabled, props.sendBlocked, host, draft.id, draft.sessionId]);
        const selection = React.useCallback(() => ({
          start: input.current?.selectionStart ?? draft.getSnapshot().text.length,
          end: input.current?.selectionEnd ?? draft.getSnapshot().text.length,
        }), [draft]);
        React.useLayoutEffect(() => {
          return () => speech.clearTarget(draft.id);
        }, [draft]);
        React.useLayoutEffect(() => {
          speech.setTarget({ draft, disabled: props.disabled, sendBlocked: props.sendBlocked, selection });
        }, [draft, props.disabled, props.sendBlocked, selection]);
        React.useLayoutEffect(() => {
          const focus = state.focus;
          if (!focus || focus.id !== draft.id || focus.revision !== snapshot.revision || props.disabled) return;
          input.current?.focus();
          input.current?.setSelectionRange(focus.selection.start, focus.selection.end);
        }, [state.focus, draft.id, snapshot.revision, props.disabled]);
        const retry = state.phase === 'retry';
        const sendError = state.phase === 'send-error';
        const active = state.phase !== 'idle' && !retry && !sendError;
        const busy = active && state.phase !== 'recording';
        const label = state.phase === 'recording' ? (state.holdingAtLimit ? '录音已达两分钟' : '停止录音并收取剩余文字')
          : state.phase === 'permission' ? '正在启动麦克风'
              : state.phase === 'stopping' ? '正在提交录音'
                : state.phase === 'transcribing' ? '正在转写录音'
                  : state.phase === 'sending' ? '正在发送'
                    : sendError ? state.error!
                      : retry ? `语音失败，点击重试。${state.error ?? ''}` : '开始语音输入';
        const disabled = sendError || busy || (!active && (props.disabled || props.sendBlocked || !(retry ? speech.canRetry(draft.id) : speech.canStart(draft.id))));
        const button = h('button', {
          type: 'button', className: `ck-icon-button cockpit-speech-mic${retry ? ' cockpit-speech-retry' : ''}`, disabled,
          'aria-label': label, title: state.error ?? (state.phase === 'idle'
            ? `${label}；空输入可按住 F8 说话，松开发送（网页需聚焦，Fn 由设备决定）` : label),
          'aria-pressed': state.phase === 'recording', 'aria-busy': busy,
          onClick: () => {
            keyboard.interrupt();
            gesture.interrupt();
            if (state.phase === 'recording') void speech.stop(draft.id);
            else if (retry) void speech.retry(draft.id);
            else if (!busy && !sendError) void speech.start('button', draft.id);
          },
        }, busy ? h('span', { className: 'cockpit-speech-spinner', 'aria-hidden': true })
          : state.phase === 'recording' ? h(Icon, { name: 'stop', className: 'ck-icon-md cockpit-speech-stop' })
            : h(Icon, { name: sendError ? 'error' : retry ? 'retry' : 'mic' }));
        const showGesture = holding || (!focused && props.value === '' && snapshot.text === ''
          && !props.disabled && !props.sendBlocked && speech.canStart(draft.id));
        return h(React.Fragment, null,
          h('div', { className: 'cockpit-speech-input' },
            h(Base, { ...props, editorRef: ref,
              placeholder: showGesture ? '' : props.placeholder,
              onFocus: event => { setFocused(true); gesture.interrupt(); props.onFocus?.(event); },
              onBlur: event => { setFocused(false); props.onBlur?.(event); },
            }),
            showGesture ? h('div', {
              className: 'cockpit-speech-hold ck-input-hint', 'aria-hidden': true,
              onPointerDown: event => { if (gesture.down(event, event.currentTarget)) event.preventDefault(); },
              onPointerMove: event => {
                for (const point of event.nativeEvent.getCoalescedEvents?.() ?? []) gesture.move(point);
                gesture.move(event);
              },
              onPointerUp: event => { gesture.up(event); },
              onPointerCancel: event => { gesture.lost(event.pointerId); },
              onLostPointerCapture: event => { gesture.lost(event.pointerId); },
              onContextMenu: event => event.preventDefault(),
              // Keep the touch target mounted through release; focus in the completed click gesture.
              onClick: event => { event.preventDefault(); gesture.click(); },
            }, holding && active ? '' : '轻点输入，按住说话',
            holding && active ? null : h('span', { className: 'cockpit-speech-key-hint' }, '(F8)')) : null,
          ), button,
        );
      },
    }, {
      id: 'speech-feedback', boundary: 'composer',
      wrap: Base => function SpeechComposer(props) {
        React.useSyncExternalStore(props.draft.subscribe, props.draft.getSnapshot);
        return h(React.Fragment, null, h(Base, props), h(SpeechPanel, { id: props.draft.id }));
      },
    }, {
      id: 'speech-status', boundary: 'composerEditor',
      wrap: Base => function SpeechEditor(props) {
        React.useSyncExternalStore(props.draft.subscribe, props.draft.getSnapshot);
        return h('div', { className: 'cockpit-speech-editor' }, h(SpeechStatus, { id: props.draft.id }), h(Base, props));
      },
    }],
  };
};
