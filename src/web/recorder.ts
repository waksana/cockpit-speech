import { abortError, isRecord, MAX_RESPONSE_BYTES, MAX_SECONDS, MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';
import { parseSession } from '../shared/session.ts';
import type { SpeechSession } from '../shared/session.ts';

export interface Recording {
  stop(committed?: () => void): Promise<string>;
  cancel(): void;
}
export interface RecordingPreparation {
  start(session: SpeechSession): Promise<Recording>;
  cancel(): void;
}
export type PrepareRecording = (signal: AbortSignal, fail: (error: SpeechError) => void, limit: () => void) => RecordingPreparation;
export interface AudioEnvironment {
  secure: boolean;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): AudioContext;
  createPeer(): RTCPeerConnection;
  fetch: typeof fetch;
}
export function browserAudio(): AudioEnvironment {
  return {
    secure: globalThis.isSecureContext,
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    createContext: () => new AudioContext(),
    createPeer: () => new RTCPeerConnection(),
    fetch: (...args) => fetch(...args),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function readSdp(response: Response): Promise<string> {
  if (!response.body) throw new SpeechError('CONNECTION_FAILED', 'Azure 未返回连接响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) throw new SpeechError('CONNECTION_FAILED', 'Azure 连接响应超过上限。');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (!text.startsWith('v=0')) throw new SpeechError('CONNECTION_FAILED', 'Azure 未返回有效的 WebRTC 连接响应。');
    return text;
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

export function prepareRecording(signal: AbortSignal, fail: (error: SpeechError) => void, limit: () => void, env = browserAudio()): RecordingPreparation {
  if (!env.secure) throw new SpeechError('MIC_UNAVAILABLE', '语音输入需要 HTTPS（或 localhost），以及支持 Web Audio 和 WebRTC 的浏览器。');
  signal.throwIfAborted();
  const lifetime = new AbortController();
  let context: AudioContext | undefined;
  let microphone: MediaStream | undefined;
  let output: MediaStreamAudioDestinationNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let gate: GainNode | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let closed = false;
  let started = false;
  let stopping = false;
  let commitSent = false;
  let failure: SpeechError | undefined;
  let committedId: string | undefined;
  let completion: { itemId: string; text: string } | undefined;
  let stopPromise: Promise<string> | undefined;
  let resolveStop: ((text: string) => void) | undefined;
  let rejectStop: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  let clearedBuffer: (() => void) | undefined;
  const stopMicrophone = () => {
    if (microphone) {
      for (const track of microphone.getTracks()) { track.onended = null; track.stop(); }
      microphone = undefined;
    }
    source?.disconnect(); source = undefined;
    gate?.disconnect(); gate = undefined;
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    lifetime.abort(failure ?? abortError());
    signal.removeEventListener('abort', cancel);
    clearTimeout(timer); clearTimeout(flushTimer); clearTimeout(finalTimer);
    stopMicrophone();
    if (output) for (const track of output.stream.getTracks()) track.stop();
    output?.disconnect();
    if (channel) {
      channel.onopen = null; channel.onclose = null; channel.onerror = null; channel.onmessage = null;
      channel.close();
    }
    if (peer) { peer.onconnectionstatechange = null; peer.close(); }
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => fail(new SpeechError('AUDIO_CLOSE_FAILED', '麦克风和连接已断开，但浏览器未能关闭音频上下文。')));
    }
  };
  const cancel = () => { rejectStop?.(abortError()); cleanup(); };
  const failed = (error: SpeechError) => {
    if (closed) return;
    failure = error;
    rejectStop?.(error);
    cleanup();
    fail(error);
  };
  const finish = () => {
    if (!completion || !committedId || closed) return;
    if (completion.itemId !== committedId) {
      failed(new SpeechError('PROVIDER_RESPONSE', 'Azure 返回了不属于本次录音的识别结果。'));
      return;
    }
    resolveStop?.(completion.text);
    cleanup();
  };
  const onMessage = (event: MessageEvent) => {
    if (closed) return;
    try {
      if (typeof event.data !== 'string' || event.data.length > MAX_RESPONSE_BYTES) throw new Error('invalid event');
      const value: unknown = JSON.parse(event.data);
      if (!isRecord(value) || typeof value.type !== 'string') throw new Error('invalid event');
      if (value.type === 'error' || value.type === 'conversation.item.input_audio_transcription.failed') {
        failed(new SpeechError('PROVIDER_FAILED', 'Azure OpenAI 转写失败，请重新录音；未自动重试。'));
      } else if (value.type === 'input_audio_buffer.cleared') {
        clearedBuffer?.();
        clearedBuffer = undefined;
      } else if (value.type === 'input_audio_buffer.committed') {
        if (!commitSent || committedId || typeof value.item_id !== 'string' || !value.item_id || value.item_id.length > 256) throw new Error('invalid commit');
        committedId = value.item_id;
        finish();
      } else if (value.type === 'conversation.item.input_audio_transcription.completed') {
        if (!commitSent || completion || typeof value.item_id !== 'string' || !value.item_id || value.item_id.length > 256
          || value.content_index !== 0 || typeof value.transcript !== 'string'
          || value.transcript.length > MAX_TEXT_POINTS * 2 || [...value.transcript].length > MAX_TEXT_POINTS) throw new Error('invalid completion');
        if (!value.transcript.trim()) {
          failed(new SpeechError('NO_SPEECH', '未识别到语音，请重新录音。'));
          return;
        }
        completion = { itemId: value.item_id, text: value.transcript.trim() };
        finish();
      }
    } catch { failed(new SpeechError('PROVIDER_RESPONSE', 'Azure 返回了无效或过大的转写事件。')); }
  };
  signal.addEventListener('abort', cancel, { once: true });
  let resumed: Promise<void>;
  try {
    // Unlock audio during the click; credentials and permission are acquired afterward.
    context = env.createContext();
    resumed = context.resume();
    void resumed.catch(() => {});
  } catch {
    cleanup();
    signal.throwIfAborted();
    throw new SpeechError('MIC_UNAVAILABLE', '无法初始化音频，请检查 HTTPS、浏览器支持和音频设备。');
  }
  const audioContext = context;
  return {
    cancel,
    async start(session) {
      if (closed || started || signal.aborted) throw abortError();
      started = true;
      let deadline: AbortSignal | undefined;
      try {
        parseSession(session);
        const acquired = env.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false,
        }).then(value => {
          if (closed || signal.aborted) {
            for (const track of value.getTracks()) track.stop();
            throw abortError();
          }
          microphone = value;
          return value;
        });
        await abortable(Promise.all([resumed, acquired]), lifetime.signal);
        if (audioContext.state !== 'running') throw new SpeechError('MIC_UNAVAILABLE', '音频设备未启动，请检查浏览器麦克风权限。');
        parseSession(session);
        deadline = AbortSignal.timeout(30_000);
        const connectionSignal = AbortSignal.any([lifetime.signal, deadline]);
        peer = env.createPeer();
        output = audioContext.createMediaStreamDestination();
        for (const track of output.stream.getTracks()) peer.addTrack(track, output.stream);
        channel = peer.createDataChannel('oai-events');
        const opened = new Promise<void>(resolve => { channel!.onopen = () => resolve(); });
        const cleared = new Promise<void>(resolve => { clearedBuffer = resolve; });
        channel.onmessage = onMessage;
        channel.onclose = channel.onerror = () => failed(new SpeechError('CONNECTION_LOST', '语音连接已断开，请重新录音；未自动重连。'));
        peer.onconnectionstatechange = () => {
          if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected' || peer?.connectionState === 'closed') {
            failed(new SpeechError('CONNECTION_LOST', 'Azure WebRTC 连接已断开，请重新录音；未自动重连。'));
          }
        };
        const offer = await abortable(peer.createOffer(), connectionSignal);
        await abortable(peer.setLocalDescription(offer), connectionSignal);
        const response = await abortable(env.fetch(session.callsUrl, {
          method: 'POST', headers: { Authorization: `Bearer ${session.clientSecret}`, 'Content-Type': 'application/sdp' },
          body: offer.sdp, redirect: 'error', signal: connectionSignal,
        }), connectionSignal);
        if (!response.ok) {
          await response.body?.cancel();
          throw new SpeechError('CONNECTION_FAILED', `Azure WebRTC 连接失败（HTTP ${response.status}），请重新开始；未自动重试。`);
        }
        const sdp = await abortable(readSdp(response), connectionSignal);
        await abortable(peer.setRemoteDescription({ type: 'answer', sdp }), connectionSignal);
        await abortable(opened, connectionSignal);
        if (closed) throw abortError();
        channel.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
        await abortable(cleared, connectionSignal);
        if (closed) throw abortError();
        source = audioContext.createMediaStreamSource(microphone!);
        gate = audioContext.createGain();
        gate.gain.setValueAtTime(1, audioContext.currentTime);
        // Audio-render-clock gating also bounds transmission if the JS timer is delayed.
        gate.gain.setValueAtTime(0, audioContext.currentTime + MAX_SECONDS);
        source.connect(gate); gate.connect(output);
        audioContext.onstatechange = () => {
          if (!stopping && audioContext.state !== 'running') failed(new SpeechError('AUDIO_FAILED', '浏览器暂停了音频，请重新录音。'));
        };
        for (const track of microphone!.getTracks()) track.onended = () => failed(new SpeechError('AUDIO_FAILED', '麦克风已断开或权限已撤销。'));
        timer = setTimeout(() => {
          if (closed || stopping) return;
          stopMicrophone();
          limit();
        }, MAX_SECONDS * 1000);
        return {
          stop(committed) {
            if (stopPromise) return stopPromise;
            if (closed) return Promise.reject(abortError());
            stopping = true;
            clearTimeout(timer);
            stopMicrophone();
            stopPromise = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
            void (async () => {
              // Stop hardware now, but keep the silent output track alive to drain final RTP audio.
              await abortable(new Promise<void>(resolve => { flushTimer = setTimeout(resolve, 250); }), lifetime.signal);
              if (closed) return;
              finalTimer = setTimeout(() => failed(new SpeechError('PROVIDER_TIMEOUT', 'Azure OpenAI 转写超时，未自动重试。')), 90_000);
              commitSent = true;
              committed?.();
              if (!closed) channel!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            })().catch(error => {
              if (!closed) failed(error instanceof SpeechError ? error : new SpeechError('CONNECTION_LOST', '无法提交录音，请重新开始语音输入。'));
            });
            return stopPromise;
          },
          cancel,
        };
      } catch (error) {
        const cancelled = closed && !failure;
        cleanup();
        if (failure) throw failure;
        if (cancelled) throw abortError();
        signal.throwIfAborted();
        if (deadline?.aborted) throw new SpeechError('CONNECTION_TIMEOUT', 'Azure WebRTC 连接超时，请检查网络；未自动重试。');
        if (error instanceof SpeechError) throw error;
        throw new SpeechError('MIC_UNAVAILABLE', '无法准备麦克风或 Azure WebRTC 连接，请检查权限、配置和网络。');
      }
    },
  };
}
