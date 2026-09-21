import type { ActivateNextFrontend, DraftReference } from '@cockpit/module-api';
import { createSpeechFrontend } from '../frontend.ts';
import { icons } from '../icons.ts';
import { RemovedActionFocus } from './focus.ts';

export const activate: ActivateNextFrontend = context => {
  if (context.ui?.version !== 1 || !context.ui.Button || !context.ui.Label || !context.ui.Textarea
    || !context.ui.Alert || !context.ui.AlertTitle || !context.ui.AlertDescription) {
    throw new Error('语音新界面需要配套宿主的公共组件 v1，请先升级宿主。');
  }
  const React = context.react;
  const h = React.createElement;
  const { Button, Label, Textarea, Alert, AlertTitle, AlertDescription } = context.ui;
  const { speech, useSpeech, useInput, copyRecovery, dispose } = createSpeechFrontend(context);

  function Icon({ name }: { name: keyof typeof icons }) {
    return h('svg', { className: 'csp-next-icon', width: 20, height: 20, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, ...icons[name].map(([tag, attrs], key) => h(tag, { ...attrs, key })));
  }

  function Feedback({ draft, scope }: { draft: DraftReference; scope: { current: HTMLDivElement | null } }) {
    const id = draft.id;
    const state = useSpeech(id);
    React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
    const resultId = React.useId();
    const [retrying, setRetrying] = React.useState(false);
    const retryRun = React.useRef<object | null>(null);
    React.useLayoutEffect(() => () => { retryRun.current = null; }, []);
    const focus = React.useMemo(() => new RemovedActionFocus(() => {
      const host = context.state.host.getSnapshot();
      if (!host.connected || !host.visible || host.sessionId !== draft.sessionId || draft.getSnapshot().retired) return null;
      return scope.current?.querySelector<HTMLButtonElement>('.csp-next-clear')
        ?? scope.current?.querySelector<HTMLButtonElement>('.csp-next-mic') ?? null;
    }), [draft, scope]);
    React.useLayoutEffect(focus.restore);
    if (state.phase === 'idle' && !state.recovery && !state.notice && !retrying) return null;
    const recording = state.phase === 'recording';
    const retry = state.phase === 'retry';
    const sendError = state.phase === 'send-error';
    const active = !['idle', 'retry', 'send-error'].includes(state.phase);
    const recovery = !active ? state.recovery : null;
    const uncertain = state.phase === 'sending' || state.sendOutcome === 'unconfirmed';
    const title = state.phase === 'permission' ? '正在准备麦克风'
      : recording ? (state.holdingAtLimit ? '已达两分钟，等待松开' : '正在录音')
        : state.phase === 'stopping' ? '正在收取录音尾部'
          : state.phase === 'transcribing' ? '正在转写录音'
            : state.phase === 'sending' ? '正在提交原草稿'
              : sendError ? (state.sendOutcome === 'unconfirmed' ? '发送结果未确认' : '自动发送未执行')
                : retry ? '语音未完成'
                  : recovery ? '识别结果需要恢复' : '语音提示';
    const detail = [
      state.error,
      state.notice,
      retry ? (speech.hasRetainedRecording(id)
        ? '录音已保留，重试会重新转写这段录音，不会再次打开麦克风。'
        : '没有可重放的录音，请重新启动麦克风。') : null,
      uncertain ? '清除只丢弃本地语音资源，不会撤回可能已经提交的消息。' : null,
    ].filter(Boolean).join(' ');
    const time = `${String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0')}:${String(state.elapsedSeconds % 60).padStart(2, '0')}`;
    return h(Alert, { className: 'csp-next-feedback', role: 'region', 'aria-label': '语音输入',
      variant: retry || sendError || state.error ? 'destructive' : 'default' },
      h('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
        h(AlertTitle, null, title),
        detail ? h(AlertDescription, { className: 'csp-next-detail' }, detail) : null,
      ),
      recording ? h('div', { className: 'csp-next-recording' },
        h('span', { className: 'csp-next-meter', 'aria-hidden': true },
          h('span', { style: { transform: `scaleX(${state.holdingAtLimit ? 0 : Math.min(1, state.level * 6)})` } })),
        h('span', { className: 'csp-next-time', 'aria-label': `录音时长 ${state.elapsedSeconds} 秒` }, time),
        h('span', { className: 'csp-next-detail' }, '停止只写入草稿；按住说话时松开发送，上滑取消。'),
      ) : null,
      recovery ? h('div', { className: 'csp-next-recovery' },
        h(Label, { htmlFor: resultId }, state.sendOutcome === 'unconfirmed' ? '识别结果（可能已发送）' : '保留的识别结果'),
        h(Textarea, { id: resultId, className: 'csp-next-result', value: recovery.text, readOnly: true, rows: 4 }),
        h('div', { className: 'csp-next-actions' },
          h(Button, { type: 'button', variant: 'outline', onClick: () => {
            void copyRecovery(id, recovery);
          } }, '复制文字'),
          h(Button, { type: 'button', variant: 'outline', disabled: !speech.canInsert(id),
            onClick: () => speech.insertRecovery(id) }, '插入原草稿光标处'),
        ),
      ) : null,
      h('div', { className: 'csp-next-actions' },
        retry || retrying ? h(Button, { type: 'button', variant: 'outline', ref: focus.ref,
          className: 'csp-next-retry', disabled: !retrying && !speech.canRetry(id),
          'aria-disabled': retrying || !speech.canRetry(id), 'aria-busy': retrying,
          onClick: () => {
            if (retrying || !speech.canRetry(id)) return;
            const run = retryRun.current = {};
            setRetrying(true);
            void speech.retry(id).finally(() => {
              if (retryRun.current === run) { retryRun.current = null; setRetrying(false); }
            });
          } }, retrying ? '正在重试录音…' : speech.hasRetainedRecording(id) ? '重试录音' : '重新录音') : null,
        h(Button, { type: 'button', variant: active ? 'outline' : 'ghost', ref: focus.ref,
          className: 'csp-next-clear', onClick: () => {
            retryRun.current = null;
            setRetrying(false);
            speech.clear(id);
          } },
          uncertain ? '清除本地语音' : active ? '取消本次语音' : recovery || retry || sendError ? '丢弃本次语音' : '关闭提示'),
      ),
    );
  }

  return {
    apiVersion: 2,
    writes: ['text'],
    sends: ['draft'],
    dispose,
    components: [{
      id: 'speech-input', boundary: 'composerInput',
      wrap: Base => function SpeechInput(props) {
        const input = useInput(props);
        const { state, busy } = input;
        const recording = state.phase === 'recording';
        const label = recording ? '停止录音并写入草稿'
          : busy ? '正在处理语音' : '语音输入（只写入草稿）';
        return h(React.Fragment, null,
          h('div', { className: 'csp-next-input' },
            h(Base, input.editorProps),
            input.showGesture ? h('div', { ...input.gestureProps, className: 'csp-next-hold' },
              input.holding && input.active ? null : h('span', null, '轻点输入，按住说话，松开发送',
                h('span', { className: 'csp-next-key-hint' }, ' (F8)')),
            ) : null,
          ),
          h(Button, { type: 'button', variant: recording ? 'destructive' : 'ghost', size: 'icon',
            className: 'csp-next-mic', disabled: input.disabled || input.retry,
            'aria-label': label, title: label, 'aria-pressed': recording, 'aria-busy': busy,
            onClick: input.onMicrophone,
          }, busy ? h('span', { className: 'csp-next-spinner', 'aria-hidden': true })
            : h(Icon, { name: recording ? 'stop' : 'mic' })),
        );
      },
    }, {
      id: 'speech-feedback', boundary: 'composerEditor',
      wrap: Base => function SpeechEditor(props) {
        const scope = React.useRef<HTMLDivElement | null>(null);
        return h('div', { className: 'csp-next-editor', ref: scope },
          h(Base, props), h(Feedback, { key: props.draft.id, draft: props.draft, scope }),
        );
      },
    }],
  };
};
