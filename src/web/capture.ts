import { abortError, isRecord, MAX_SECONDS, SpeechError } from '../shared/limits.ts';
import { abortable } from './async.ts';
import { PCM_CHUNK, PCM_LIMIT } from './pcm.ts';
import { pcmLevel } from './level.ts';

export interface CaptureEnvironment {
  secure: boolean;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): AudioContext;
  createWorklet(context: AudioContext): AudioWorkletNode;
}
export const browserCapture = (): CaptureEnvironment => ({
  secure: globalThis.isSecureContext,
  getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
  createContext: () => new AudioContext({ sampleRate: 24000 }),
  createWorklet: context => new AudioWorkletNode(context, 'cockpit-speech-capture', { channelCount: 1, channelCountMode: 'explicit' }),
});

export class AudioCapture {
  readonly chunks: Uint8Array[] = [];
  readonly ready: Promise<void>;
  bytes = 0;
  sealed = false;
  private readonly lifetime = new AbortController();
  private context?: AudioContext;
  private microphone?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private started = false;
  private stopping = false;
  private closed = false;
  private error?: SpeechError;
  private timer?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private stopPromise?: Promise<void>;
  private resolveStop?: () => void;
  private rejectStop?: (error: Error) => void;
  private readonly fail: (error: SpeechError) => void;
  private readonly limit: () => void;
  private readonly env: CaptureEnvironment;
  private readonly level: (value: number) => void;
  constructor(
    signal: AbortSignal,
    fail: (error: SpeechError) => void,
    limit: () => void,
    env = browserCapture(),
    level: (value: number) => void = () => {},
  ) {
    this.fail = fail; this.limit = limit; this.env = env; this.level = level;
    signal.throwIfAborted();
    signal.addEventListener('abort', this.cancel, { once: true, signal: this.lifetime.signal });
    this.ready = this.start();
  }
  private async start(): Promise<void> {
    const setup = new AbortController();
    const timer = setTimeout(() => setup.abort(new SpeechError('MIC_TIMEOUT', '启动麦克风超时，请重试。')), 30_000);
    const signal = AbortSignal.any([this.lifetime.signal, setup.signal]);
    try {
      if (!this.env.secure) throw new SpeechError('MIC_UNAVAILABLE', '语音输入需要 HTTPS 或 localhost。');
      const context = this.context = this.env.createContext();
      let running = context.state === 'running';
      context.onstatechange = () => {
        if (this.closed || this.stopping) return;
        if (context.state === 'running') running = true;
        else if (running || context.state === 'closed') this.broken(new SpeechError('AUDIO_FAILED', '音频设备已暂停或关闭。'));
      };
      const resume = context.resume();
      // Permission and audio activation start together, independently of credentials.
      const permission = this.env.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
        .then(async stream => {
          if (signal.aborted || this.closed) { for (const track of stream.getTracks()) track.stop(); signal.throwIfAborted(); throw abortError(); }
          this.microphone = stream;
          for (const track of stream.getTracks()) track.onended = () => this.broken(new SpeechError('AUDIO_FAILED', '麦克风已断开。'));
          // WebKit can leave the pre-permission resume pending until retried while capturing.
          if (context.state === 'suspended') {
            signal.throwIfAborted();
            await context.resume();
          }
          return stream;
        });
      const module = context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      const [, stream] = await abortable(Promise.all([resume, permission, module]), signal);
      if (!stream.getAudioTracks().some(track => track.readyState === 'live') || context.state !== 'running') {
        throw new SpeechError('AUDIO_FAILED', '麦克风或音频上下文尚未就绪。');
      }
      const worklet = this.worklet = this.env.createWorklet(context);
      worklet.onprocessorerror = () => this.broken(new SpeechError('AUDIO_FAILED', '本地录音处理器发生错误。'));
      worklet.port.onmessage = event => {
        if (this.closed) return;
        const data: unknown = event.data;
        if (isRecord(data) && data.type === 'pcm' && data.buffer instanceof ArrayBuffer
          && data.buffer.byteLength > 0 && data.buffer.byteLength <= PCM_CHUNK * 2
          && data.buffer.byteLength % 2 === 0 && this.bytes + data.buffer.byteLength <= PCM_LIMIT * 2) {
          this.chunks.push(new Uint8Array(data.buffer)); this.bytes += data.buffer.byteLength;
          this.level(pcmLevel(data.buffer));
        } else if (isRecord(data) && data.type === 'ended' && typeof data.limited === 'boolean') {
          this.sealed = true; this.cleanup(); this.resolveStop?.();
          if (data.limited) this.limit();
        } else this.broken(new SpeechError('AUDIO_FAILED', '录音数据无效或超过两分钟上限。'));
      };
      this.source = context.createMediaStreamSource(stream);
      // The processor produces silence, keeping the graph alive without microphone playback.
      worklet.connect(context.destination);
      this.source.connect(worklet);
      this.started = true;
      this.timer = setTimeout(() => { this.limit(); }, MAX_SECONDS * 1000);
    } catch (error) {
      this.sealed = true; this.cleanup();
      if (error instanceof SpeechError || this.lifetime.signal.aborted) throw error;
      throw new SpeechError('MIC_FAILED', '无法启动麦克风，请检查权限、设备和浏览器支持后重试。');
    } finally { clearTimeout(timer); }
  }
  private stopHardware(): void {
    if (this.microphone) for (const track of this.microphone.getTracks()) { track.onended = null; track.stop(); }
    this.microphone = undefined;
    this.source?.disconnect(); this.source = undefined;
  }
  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer); clearTimeout(this.stopTimer);
    this.stopHardware();
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.onprocessorerror = null; this.worklet.port.close(); this.worklet.disconnect(); }
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => this.fail(new SpeechError('AUDIO_CLOSE_FAILED', '浏览器未能关闭音频上下文。')));
    }
  }
  private broken(error: SpeechError): void {
    if (this.closed || this.stopping) return;
    this.error = error; this.sealed = true;
    this.lifetime.abort(error); this.cleanup(); this.rejectStop?.(error);
    if (this.started) this.fail(error);
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.sealed) return this.error ? Promise.reject(this.error) : Promise.resolve();
    this.stopping = true; this.stopHardware(); clearTimeout(this.timer);
    this.stopPromise = new Promise((resolve, reject) => { this.resolveStop = resolve; this.rejectStop = reject; });
    this.stopTimer = setTimeout(() => {
      const error = new SpeechError('AUDIO_FLUSH_TIMEOUT', '收取录音尾部超时，已保留收到的音频，可重试。');
      this.error = error; this.sealed = true; this.cleanup(); this.rejectStop?.(error);
    }, 2000);
    this.worklet?.port.postMessage({ type: 'stop' });
    return this.stopPromise;
  }
  cancel = (): void => {
    this.lifetime.abort(abortError()); this.sealed = true; this.cleanup();
    this.rejectStop?.(abortError()); this.chunks.length = 0; this.bytes = 0;
  };
}
