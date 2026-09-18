import { abortError, MAX_SAMPLES, MAX_SECONDS, SAMPLE_RATE, SpeechError } from '../shared/limits.ts';
import { encodeWav } from '../shared/wav.ts';

export interface Recording {
  stop(): Promise<Uint8Array<ArrayBuffer>>;
  cancel(): void;
}
export type StartRecording = (signal: AbortSignal, fail: (error: SpeechError) => void) => Promise<Recording>;

export interface AudioEnvironment {
  secure: boolean;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): AudioContext;
  createNode(context: AudioContext): AudioWorkletNode;
}

export function browserAudio(): AudioEnvironment {
  return {
    secure: globalThis.isSecureContext,
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    createContext: () => new AudioContext({ sampleRate: SAMPLE_RATE }),
    createNode: context => new AudioWorkletNode(context, 'cockpit-speech-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }),
  };
}

export async function startRecording(signal: AbortSignal, fail: (error: SpeechError) => void, env = browserAudio()): Promise<Recording> {
  if (!env.secure) throw new SpeechError('MIC_UNAVAILABLE', 'Microphone recording requires HTTPS (or localhost), Web Audio and AudioWorklet support.');
  signal.throwIfAborted();
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let closed = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveStop: ((bytes: Uint8Array<ArrayBuffer>) => void) | undefined;
  let rejectStop: ((error: Error) => void) | undefined;
  const chunks: Float32Array[] = [];
  let samples = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', cancel);
    clearTimeout(timer); clearTimeout(flushTimer);
    if (stream) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    source?.disconnect();
    if (node) { node.onprocessorerror = null; node.port.onmessage = null; node.port.close(); node.disconnect(); }
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
    chunks.length = 0;
  };
  const cancel = () => {
    rejectStop?.(abortError());
    cleanup();
  };
  const failed = (error: SpeechError) => {
    if (closed) return;
    rejectStop?.(error);
    cleanup();
    fail(error);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // Both operations begin in the click gesture, before any awaited work.
    context = env.createContext();
    if (context.sampleRate !== SAMPLE_RATE || !context.audioWorklet) {
      throw new SpeechError('MIC_UNAVAILABLE', 'This browser cannot record 16 kHz WAV through AudioWorklet. Use a current browser with Web Audio support.');
    }
    const resumed = context.resume();
    // A later setup call can throw before Promise.all attaches its handlers.
    void resumed.catch(() => {});
    const permission = env.getUserMedia({ audio: { channelCount: 1 }, video: false });
    // A cancelled permission prompt cannot be dismissed by script: release a late grant immediately.
    const acquired = permission.then(value => {
      stream = value;
      if (closed || signal.aborted) {
        for (const track of value.getTracks()) track.stop();
        throw abortError();
      }
      return value;
    });
    void acquired.catch(() => {});
    await Promise.all([resumed, acquired, context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href)]);
    if (closed || signal.aborted) throw abortError();
    if (context.state !== 'running') throw new SpeechError('MIC_UNAVAILABLE', 'The audio device did not start. Check browser microphone permissions and try again.');
    node = env.createNode(context);
    node.port.onmessage = event => {
      if (closed) return;
      const data = event.data;
      if (data?.type === 'chunk' && data.samples instanceof Float32Array) {
        samples += data.samples.length;
        if (samples > MAX_SAMPLES) { failed(new SpeechError('AUDIO_LIMIT', 'Recording exceeded 120 seconds. Nothing was transcribed; record a shorter clip.')); return; }
        chunks.push(data.samples);
      } else if (data?.type === 'done' && stopping) {
        try { const bytes = encodeWav(chunks, samples); resolveStop?.(bytes); cleanup(); }
        catch { failed(new SpeechError('AUDIO_INVALID', 'No usable audio was captured. Check the microphone and try again.')); }
      } else if (data?.type === 'limit') failed(new SpeechError('AUDIO_LIMIT', 'Recording exceeded 120 seconds. Nothing was transcribed; record a shorter clip.'));
      else failed(new SpeechError('AUDIO_INVALID', 'The audio recorder returned an invalid message.'));
    };
    node.onprocessorerror = () => failed(new SpeechError('AUDIO_FAILED', 'The audio recorder stopped unexpectedly. Try recording again.'));
    context.onstatechange = () => {
      if (!stopping && context?.state !== 'running') failed(new SpeechError('AUDIO_FAILED', 'The browser suspended the microphone. Try recording again.'));
    };
    for (const track of stream!.getTracks()) track.onended = () => failed(new SpeechError('AUDIO_FAILED', 'The microphone was disconnected or its permission was revoked.'));
    source = context.createMediaStreamSource(stream!);
    source.connect(node);
    // The processor emits silence; connection keeps processing alive without microphone playback.
    node.connect(context.destination);
    timer = setTimeout(() => failed(new SpeechError('AUDIO_LIMIT', 'Recording reached the 120-second limit. Nothing was transcribed; record a shorter clip.')), MAX_SECONDS * 1000);
    return {
      stop() {
        if (closed || stopping) return Promise.reject(abortError());
        stopping = true;
        clearTimeout(timer);
        for (const track of stream!.getTracks()) { track.onended = null; track.stop(); }
        return new Promise((resolve, reject) => {
          resolveStop = resolve; rejectStop = reject;
          flushTimer = setTimeout(() => failed(new SpeechError('AUDIO_FAILED', 'The recorder could not finalize the audio. Try recording again.')), 3000);
          node!.port.postMessage('stop');
        });
      },
      cancel,
    };
  } catch (error) {
    cleanup();
    if (signal.aborted) throw abortError();
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('MIC_UNAVAILABLE', 'Microphone access failed. Check HTTPS, browser permission, and audio device availability, then try again.');
  }
}
