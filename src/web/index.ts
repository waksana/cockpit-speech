import type { ActivateFrontend, ComposerInputProps } from '@waksana/cockpit-module-sdk/frontend';
import { createSpeechFrontend } from './frontend.ts';
import { icons } from './icons.ts';

export { composeEditorRef } from './frontend.ts';

export const activate: ActivateFrontend = context => {
  if (context.apiVersion !== 2 || context.uiVersion !== 1 || context.uiSurfaceVersion !== 1 || context.chatWindowVersion !== 1
    || context.composerInputVersion !== 1 || context.draftLifecycleVersion !== 1 || context.draftSubmissionVersion !== 1
    || !context.state?.chatWindow || !context.state.bindDraft) {
    throw new Error('语音模块需要前端 API v2、UI v1、uiSurfaceVersion v1、chatWindow v1、composerInput v1、draftLifecycle v1 和 draftSubmission v1，请先升级配套宿主。');
  }
  const React = context.react;
  const h = React.createElement;
  const { speech, useSpeech, useInput, copyRecovery, dispose } = createSpeechFrontend(context);
  function Icon({ name, className = '' }: { name: keyof typeof icons; className?: string }) {
    return h('svg', { className: `ck-icon ${className}`, width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, ...icons[name].map(([tag, attrs], key) => h(tag, { ...attrs, key })));
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
    return (!active && recovery) ? h('section', { className: 'ck-surface cockpit-speech-panel', 'aria-label': '识别结果恢复' },
      recovery ? h(React.Fragment, null,
        state.error || state.notice ? h('p', { role: 'status' }, state.error ?? state.notice) : null,
        h('label', null, state.sendOutcome === 'unconfirmed' ? '识别结果（发送状态未确认）' : '识别结果（未发送）',
          h('textarea', { className: 'ck-input', value: recovery.text, readOnly: true, rows: 4 })),
        h('div', { className: 'ck-actions cockpit-speech-recovery-actions' },
          h('button', { type: 'button', className: 'ck-button', onClick: () => { void copyRecovery(id, recovery); } }, '复制文字'),
          h('button', { type: 'button', className: 'ck-button', disabled: !speech.canInsert(id), onClick: () => speech.insertRecovery(id) }, '插入原输入框光标处'),
        ),
      ) : null,
      !active ? h('button', { type: 'button', className: 'ck-button', onClick: () => speech.dismiss(id) }, recovery ? '丢弃识别结果' : '关闭提示') : null,
    ) : null;
  }
  return {
    apiVersion: 2,
    writes: ['text'],
    sends: ['draft'],
    dispose,
    components: [{
      id: 'speech-input', boundary: 'composerInput',
      wrap: Base => function SpeechInput(props: ComposerInputProps) {
        const { state, holding, active, busy, retry, sendError, disabled, showGesture, editorProps, gestureProps, onMicrophone } = useInput(props);
        const label = state.phase === 'recording' ? (state.holdingAtLimit ? '录音已达两分钟' : '停止录音并收取剩余文字')
          : state.phase === 'permission' ? '正在启动麦克风'
              : state.phase === 'stopping' ? '正在提交录音'
                : state.phase === 'transcribing' ? '正在转写录音'
                  : state.phase === 'sending' ? '正在发送'
                    : sendError ? state.error!
                      : retry ? `语音失败，点击重试。${state.error ?? ''}` : '开始语音输入';
        const button = h('button', {
          type: 'button', className: `ck-icon-button cockpit-speech-mic${retry ? ' ck-danger' : ''}`, disabled,
          'aria-label': label, title: state.error ?? (state.phase === 'idle'
            ? `${label}；空输入可在网页内按住 F8 说话，松开发送（无需聚焦输入框，Fn 由设备决定）` : label),
          'aria-pressed': state.phase === 'recording', 'aria-busy': busy,
          onClick: onMicrophone,
        }, busy ? h('span', { className: 'cockpit-speech-spinner', 'aria-hidden': true })
          : state.phase === 'recording' ? h(Icon, { name: 'stop', className: 'ck-icon-md cockpit-speech-stop' })
            : h(Icon, { name: sendError ? 'error' : retry ? 'retry' : 'mic' }));
        return h(React.Fragment, null,
          h('div', { className: 'cockpit-speech-input' },
            h(Base, editorProps),
            showGesture ? h('div', {
              ...gestureProps, className: 'cockpit-speech-hold ck-input-hint',
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
