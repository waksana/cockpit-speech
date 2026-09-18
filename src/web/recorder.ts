import { abortError, MAX_SAMPLES, MAX_SECONDS, SAMPLE_RATE, SpeechError } from '../shared/limits.ts';
import { encodeWav } from '../shared/wav.ts';

export interface Recording {
  stop(): Promise<Uint8Array<ArrayBuffer>>;
  cancel(): void;
}
export interface RecordingPreparation {
  start(): Promise<Recording>;
  cancel(): void;
}
export type PrepareRecording = (signal: AbortSignal, fail: (error: SpeechError) => void, limit: () => void) => RecordingPreparation;

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

export function prepareRecording(signal: AbortSignal, fail: (error: SpeechError) => void, limit: () => void, env = browserAudio()): RecordingPreparation {
  if (!env.secure) throw new SpeechError('MIC_UNAVAILABLE', '语音输入需要 HTTPS（或 localhost），以及支持 Web Audio 和 AudioWorklet 的浏览器。');
  signal.throwIfAborted();
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let closed = false;
  let started = false;
  let stopping = false;
  let finished = false;
  let limited = false;
  let stopPromise: Promise<Uint8Array<ArrayBuffer>> | undefined;
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
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => fail(new SpeechError('AUDIO_CLOSE_FAILED', '录音设备已断开，但浏览器未能关闭音频上下文。')));
    }
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
  const finalize = () => {
    if (!stopping || !finished || closed) return;
    try { const bytes = encodeWav(chunks, samples); resolveStop?.(bytes); cleanup(); }
    catch { failed(new SpeechError('AUDIO_INVALID', '没有录到可用音频，请检查麦克风后重试。')); }
  };
  const reachedLimit = () => {
    if (closed || stopping || limited) return;
    limited = true;
    clearTimeout(timer);
    limit();
  };
  signal.addEventListener('abort', cancel, { once: true });
  let resumed: Promise<void>;
  try {
    // Unlock Web Audio in the click gesture, but do not acquire the microphone before preflight.
    context = env.createContext();
    if (context.sampleRate !== SAMPLE_RATE || !context.audioWorklet) {
      throw new SpeechError('MIC_UNAVAILABLE', '当前浏览器无法通过 AudioWorklet 录制 16 kHz WAV，请使用支持此能力的新版浏览器。');
    }
    resumed = context.resume();
    // Readiness can fail before start() awaits this promise.
    void resumed.catch(() => {});
  } catch (error) {
    cleanup();
    if (signal.aborted) throw abortError();
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('MIC_UNAVAILABLE', '无法初始化录音，请检查 HTTPS、浏览器支持和音频设备。');
  }
  const audioContext = context;
  return {
    cancel,
    async start() {
      if (closed || started || signal.aborted) throw abortError();
      started = true;
      try {
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
        await Promise.all([resumed, acquired, audioContext.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href)]);
        if (closed || signal.aborted) throw abortError();
        if (audioContext.state !== 'running') throw new SpeechError('MIC_UNAVAILABLE', '音频设备未启动，请检查浏览器麦克风权限后重试。');
        node = env.createNode(audioContext);
        node.port.onmessage = event => {
          if (closed) return;
          const data = event.data;
          if (data?.type === 'chunk' && data.samples instanceof Float32Array && !finished) {
            samples += data.samples.length;
            if (samples > MAX_SAMPLES) { failed(new SpeechError('AUDIO_LIMIT', '录音器返回的音频超过上限，已停止处理。')); return; }
            chunks.push(data.samples);
          } else if (data?.type === 'done') { finished = true; finalize(); }
          else if (data?.type === 'limit') reachedLimit();
          else failed(new SpeechError('AUDIO_INVALID', '录音器返回了无效数据。'));
        };
        node.onprocessorerror = () => failed(new SpeechError('AUDIO_FAILED', '录音器意外停止，请重新录音。'));
        audioContext.onstatechange = () => {
          if (!stopping && audioContext.state !== 'running') failed(new SpeechError('AUDIO_FAILED', '浏览器暂停了麦克风，请重新录音。'));
        };
        for (const track of stream!.getTracks()) track.onended = () => failed(new SpeechError('AUDIO_FAILED', '麦克风已断开或录音权限已撤销。'));
        source = audioContext.createMediaStreamSource(stream!);
        source.connect(node);
        // The processor emits silence; connection keeps processing alive without microphone playback.
        node.connect(audioContext.destination);
        timer = setTimeout(reachedLimit, MAX_SECONDS * 1000);
        return {
          stop() {
            if (stopPromise) return stopPromise;
            if (closed) return Promise.reject(abortError());
            stopping = true;
            clearTimeout(timer);
            for (const track of stream!.getTracks()) { track.onended = null; track.stop(); }
            stopPromise = new Promise((resolve, reject) => {
              resolveStop = resolve; rejectStop = reject;
              if (finished) finalize();
              else {
                flushTimer = setTimeout(() => failed(new SpeechError('AUDIO_FAILED', '录音未能完成封装，请重新录音。')), 3000);
                node!.port.postMessage('stop');
              }
            });
            return stopPromise;
          },
          cancel,
        };
      } catch (error) {
        cleanup();
        if (signal.aborted) throw abortError();
        if (error instanceof SpeechError) throw error;
        throw new SpeechError('MIC_UNAVAILABLE', '无法访问麦克风，请检查 HTTPS、浏览器权限和音频设备后重试。');
      }
    },
  };
}
