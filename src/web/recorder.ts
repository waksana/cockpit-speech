import { abortError, SpeechError } from '../shared/limits.ts';
import { AudioCapture, browserCapture } from './capture.ts';
import type { CaptureEnvironment } from './capture.ts';
import { transcribe } from './socket.ts';
import type { OpenSocket } from './socket.ts';
import type { CreateSession } from './transport.ts';

export interface Recording {
  stop(committed?: () => void): Promise<string>;
  retry(committed?: () => void): Promise<string>;
  retryable(): boolean;
  cancel(): void;
}
export interface RecordingPreparation {
  start(session: CreateSession, context?: string): Promise<Recording>;
  cancel(): void;
}
export type PrepareRecording = (signal: AbortSignal, fail: (error: SpeechError) => void, limit: () => void) => RecordingPreparation;
export interface AudioEnvironment extends CaptureEnvironment { openSocket: OpenSocket }
export const browserAudio = (): AudioEnvironment => ({ ...browserCapture(), openSocket: url => new WebSocket(url, ['realtime']) });

export function prepareRecording(
  signal: AbortSignal, fail: (error: SpeechError) => void, limit: () => void, env = browserAudio(),
): RecordingPreparation {
  signal.throwIfAborted();
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  let attempt: AbortController | undefined;
  const audio = new AudioCapture(combined, error => { attempt?.abort(error); fail(error); }, limit, env);
  let started = false;
  const cancel = () => { lifetime.abort(abortError()); attempt?.abort(abortError()); audio.cancel(); };
  return {
    cancel,
    async start(session, context) {
      if (started) throw new SpeechError('RECORDING_ACTIVE', '录音已经启动。');
      started = true;
      let onCommit: (() => void) | undefined;
      const send = (refresh: boolean) => {
        attempt?.abort(abortError());
        attempt = new AbortController();
        const requestSignal = AbortSignal.any([combined, attempt.signal]);
        return (async () => {
          const credential = await session(requestSignal, refresh);
          requestSignal.throwIfAborted();
          return transcribe(credential, context, audio, requestSignal, () => onCommit?.(), env.openSocket);
        })().then(text => ({ ok: true as const, text }), error => ({ ok: false as const, error }));
      };
      let result = send(false);
      try { await audio.ready; combined.throwIfAborted(); }
      catch (error) { cancel(); throw error; }
      let pending: Promise<string> | undefined;
      const unwrap = async () => {
        const outcome = await result;
        combined.throwIfAborted();
        if (!outcome.ok) throw outcome.error;
        return outcome.text;
      };
      return {
        cancel,
        retryable: () => audio.sealed && audio.bytes >= 4800 && !combined.aborted,
        stop(committed) {
          if (pending) return pending;
          onCommit = committed;
          pending = (async () => { await audio.stop(); return unwrap(); })();
          return pending;
        },
        retry(committed) {
          combined.throwIfAborted();
          if (!audio.sealed || audio.bytes < 4800) throw new SpeechError('AUDIO_TOO_SHORT', '录音不足 0.1 秒，请重新录音。');
          onCommit = committed;
          result = send(true);
          pending = unwrap();
          return pending;
        },
      };
    },
  };
}
