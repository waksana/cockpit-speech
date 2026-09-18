import type { ActivateFrontend, ComposerEditorProps } from '@cockpit/module-api';
import type { Ref } from 'react';
import { icons } from './icons.ts';
import { startRecording } from './recorder.ts';
import { SpeechService } from './speech.ts';
import { transcriptionClient } from './transport.ts';

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
    || context.composerActionsVersion !== 1 || !context.state?.chatWindow || !context.state.bindDraft) {
    throw new Error('Cockpit Speech requires frontend API v2, UI v1, chatWindow v1 and composerActions v1. Upgrade to the paired host SDK first.');
  }
  const React = context.react;
  const h = React.createElement;
  const speech = context.state.register({
    id: 'speech',
    create: () => new SpeechService({
      signal: context.signal, host: context.state.host, chatWindow: context.state.chatWindow,
      record: startRecording, transcribe: transcriptionClient(context.request), report: context.report,
    }),
    dispose: service => service.dispose(),
  }).get();
  function Icon({ name }: { name: keyof typeof icons }) {
    return h('svg', { className: 'ck-icon', width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, ...icons[name].map(([tag, attrs], key) => h(tag, { ...attrs, key })));
  }
  return {
    apiVersion: 2,
    writes: ['text'],
    components: [{
      id: 'speech-editor', boundary: 'composerEditor',
      wrap: Base => function SpeechEditor(props: ComposerEditorProps) {
        const draft = context.state.bindDraft(props.draft);
        const input = React.useRef<HTMLTextAreaElement | null>(null);
        const ref = React.useMemo(() => composeEditorRef(input, props.editorRef), [props.editorRef]);
        const state = React.useSyncExternalStore(speech.subscribe, speech.getSnapshot);
        React.useSyncExternalStore(draft.subscribe.bind(draft), draft.getSnapshot.bind(draft));
        React.useSyncExternalStore(context.state.host.subscribe, context.state.host.getSnapshot);
        const selection = React.useCallback(() => ({
          start: input.current?.selectionStart ?? draft.getSnapshot().text.length,
          end: input.current?.selectionEnd ?? draft.getSnapshot().text.length,
        }), [draft]);
        React.useLayoutEffect(() => {
          speech.setTarget({ draft, disabled: props.disabled, sendBlocked: props.sendBlocked, selection });
          return () => speech.clearTarget(draft.id);
        }, [draft, props.disabled, props.sendBlocked, selection]);
        const active = state.phase !== 'idle';
        const label = state.phase === 'recording' ? 'Stop recording and transcribe'
          : active ? 'Cancel speech recording or transcription' : 'Record speech';
        const disabled = !active && (props.disabled || props.sendBlocked || !speech.canStart());
        const button = h('button', {
          type: 'button', className: 'ck-icon-button cockpit-speech-mic', disabled,
          'aria-label': label, title: label, 'aria-pressed': active,
          onClick: () => { if (state.phase === 'recording') void speech.stop(); else if (active) speech.cancel(); else void speech.start(); },
        }, h(Icon, { name: active ? 'square' : 'mic' }));
        const progress = state.phase === 'permission' ? 'Waiting for microphone permission…'
          : state.phase === 'recording' ? 'Recording. Stop to transcribe (maximum 120 seconds).'
          : state.phase === 'stopping' ? 'Finalizing audio…' : state.phase === 'transcribing' ? 'Transcribing with Azure Speech…' : state.notice;
        const recovery = state.recovery;
        const panel = (active || state.error || state.notice || recovery) ? h('section', { className: 'cockpit-speech-panel', 'aria-label': 'Speech recording' },
          state.error ? h('p', { role: 'alert' }, state.error) : null,
          progress ? h('p', { role: 'status', 'aria-live': 'polite' }, progress) : null,
          active ? h('button', { type: 'button', className: 'ck-button', onClick: () => speech.cancel() }, 'Cancel speech') : null,
          recovery ? h(React.Fragment, null,
            h('label', null, 'Recognized text (not sent)', h('textarea', { className: 'ck-input', value: recovery.text, readOnly: true, rows: 4 })),
            h('div', { className: 'cockpit-speech-recovery-actions' },
              h('button', { type: 'button', className: 'ck-button', onClick: () => {
                void (async () => {
                  try { await navigator.clipboard.writeText(recovery.text); }
                  catch { speech.notifyCopyFailure(); }
                })();
              } }, 'Copy text'),
              h('button', { type: 'button', className: 'ck-button', disabled: !speech.canInsert(), onClick: () => speech.insertRecovery() }, 'Insert at current cursor'),
            ),
          ) : null,
          !active ? h('button', { type: 'button', className: 'ck-button', onClick: () => speech.dismiss() }, recovery ? 'Discard recognized text' : 'Dismiss') : null,
        ) : null;
        return h(React.Fragment, null,
          h(Base, { ...props, editorRef: ref, actions: h(React.Fragment, null, props.actions, button) }),
          panel,
        );
      },
    }],
  };
};
