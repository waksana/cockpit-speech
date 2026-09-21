import type { ComposerInputProps, ModuleFrontendServices } from '@cockpit/module-api';
import type { HTMLAttributes, Ref } from 'react';
import { HoldGesture } from './hold.ts';
import { KeyboardHold } from './keyboard.ts';
import { prepareRecording } from './recorder.ts';
import { SpeechService } from './speech.ts';
import type { Recovery } from './speech.ts';
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

export function protectSpeechUnload(speech: SpeechService, target: EventTarget): () => void {
  const beforeUnload = (event: Event) => {
    if (!speech.hasUnpersistedWork()) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = '';
  };
  target.addEventListener('beforeunload', beforeUnload);
  return () => target.removeEventListener('beforeunload', beforeUnload);
}

export function createSpeechFrontend(context: ModuleFrontendServices) {
  if (context.apiVersion !== 2 || context.chatWindowVersion !== 1 || context.composerInputVersion !== 1
    || context.draftLifecycleVersion !== 1 || context.draftSubmissionVersion !== 1
    || !context.state?.chatWindow || !context.state.bindDraft) {
    throw new Error('语音模块需要前端 API v2、chatWindow v1、composerInput v1、draftLifecycle v1 和 draftSubmission v1，请先升级配套宿主。');
  }
  const React = context.react;
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
  const unprotect = protectSpeechUnload(speech, window);
  const dispose = () => {
    context.signal.removeEventListener('abort', dispose);
    keyboard.dispose();
    unsubscribeKeyboard();
    unprotect();
  };
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();

  function useSpeech(id: string) {
    const snapshot = React.useCallback(() => speech.getSnapshot(id), [id]);
    return React.useSyncExternalStore(speech.subscribe, snapshot);
  }
  async function copyRecovery(id: string, recovery: Recovery): Promise<void> {
    try { await navigator.clipboard.writeText(recovery.text); }
    catch { speech.notifyCopyFailure(id, recovery); }
  }

  function useInput(props: ComposerInputProps) {
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
    React.useLayoutEffect(() => () => speech.clearTarget(draft.id), [draft]);
    React.useLayoutEffect(() => {
      speech.setTarget({ draft, disabled: props.disabled, sendBlocked: props.sendBlocked, selection });
    }, [draft, props.disabled, props.sendBlocked, selection]);
    React.useLayoutEffect(() => {
      const focus = state.focus;
      if (!focus || focus.id !== draft.id || focus.revision !== snapshot.revision || props.disabled) return;
      if (focus.activate) input.current?.focus();
      input.current?.setSelectionRange(focus.selection.start, focus.selection.end);
    }, [state.focus, draft.id, snapshot.revision, props.disabled]);
    const retry = state.phase === 'retry';
    const sendError = state.phase === 'send-error';
    const active = state.phase !== 'idle' && !retry && !sendError;
    const busy = active && state.phase !== 'recording';
    const disabled = sendError || busy || (!active && (props.disabled || props.sendBlocked || !(retry ? speech.canRetry(draft.id) : speech.canStart(draft.id))));
    const onMicrophone = () => {
      keyboard.interrupt();
      gesture.interrupt();
      if (state.phase === 'recording') void speech.stop(draft.id);
      else if (retry) void speech.retry(draft.id);
      else if (!busy && !sendError) void speech.start('button', draft.id);
    };
    const showGesture = holding || (!focused && props.value === '' && snapshot.text === ''
      && !props.disabled && !props.sendBlocked && speech.canStart(draft.id));
    const editorProps: ComposerInputProps = {
      ...props, editorRef: ref, placeholder: showGesture ? '' : props.placeholder,
      onFocus: event => { setFocused(true); gesture.interrupt(); props.onFocus?.(event); },
      onBlur: event => { setFocused(false); props.onBlur?.(event); },
    };
    const gestureProps: HTMLAttributes<HTMLDivElement> = {
      'aria-hidden': true,
      onPointerDown: event => { if (gesture.down(event, event.currentTarget)) event.preventDefault(); },
      onPointerMove: event => {
        for (const point of event.nativeEvent.getCoalescedEvents?.() ?? []) gesture.move(point);
        gesture.move(event);
      },
      onPointerUp: event => { gesture.up(event); },
      onPointerCancel: event => { gesture.lost(event.pointerId); },
      onLostPointerCapture: event => { gesture.lost(event.pointerId); },
      onContextMenu: event => event.preventDefault(),
      // Mobile focus must follow the completed click, not removal of the touch target on pointerup.
      onClick: event => { event.preventDefault(); gesture.click(); },
    };
    return { id: draft.id, state, holding, active, busy, retry, sendError, disabled, showGesture, editorProps, gestureProps, onMicrophone };
  }
  return { speech, useSpeech, useInput, copyRecovery, dispose };
}
