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
  start(session: CreateSession, context?: string, options?: { waitForStop: boolean }): Promise<Recording>;
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
  let captureActive = true;
  let waitForStop = false;
  const audio = new AudioCapture(combined, error => {
    // A late capture cleanup callback must not fail a newer replay connection.
    if (!captureActive || combined.aborted) return;
    captureActive = false;
    attempt?.abort(error); fail(error);
  }, () => {
    if (!waitForStop) { limit(); return; }
    captureActive = false;
    void audio.stop().then(limit, error => {
      if (!combined.aborted) fail(error instanceof SpeechError ? error : new SpeechError('AUDIO_FAILED', '停止本地录音失败。'));
    });
  }, env);
  let started = false;
  const cancel = () => { captureActive = false; lifetime.abort(abortError()); attempt?.abort(abortError()); audio.cancel(); };
  return {
    cancel,
    async start(session, context, options) {
      if (started) throw new SpeechError('RECORDING_ACTIVE', '录音已经启动。');
      started = true;
      waitForStop = options?.waitForStop ?? false;
      let commitAllowed = !waitForStop;
      // A held recording may be sealed at the audio limit without permission to commit.
      const queue = {
        chunks: audio.chunks,
        get bytes() { return audio.bytes; },
        get sealed() { return audio.sealed && commitAllowed; },
      };
      let onCommit: (() => void) | undefined;
      const send = (refresh: boolean) => {
        attempt?.abort(abortError());
        attempt = new AbortController();
        const requestSignal = AbortSignal.any([combined, attempt.signal]);
        return (async () => {
          const credential = await session(requestSignal, refresh);
          requestSignal.throwIfAborted();
          return transcribe(credential, context, queue, requestSignal, () => onCommit?.(), env.openSocket);
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
          commitAllowed = true;
          pending = (async () => {
            try { await audio.stop(); } finally { captureActive = false; }
            return unwrap();
          })();
          return pending;
        },
        retry(committed) {
          combined.throwIfAborted();
          if (!audio.sealed || audio.bytes < 4800) throw new SpeechError('AUDIO_TOO_SHORT', '录音不足 0.1 秒，请重新录音。');
          captureActive = false;
          onCommit = committed;
          commitAllowed = true;
          result = send(true);
          pending = unwrap();
          return pending;
        },
      };
    },
  };
}
