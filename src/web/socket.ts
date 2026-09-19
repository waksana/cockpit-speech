import { isRecord, MAX_CONTEXT_POINTS, MAX_RESPONSE_BYTES, MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';
import { parseSession } from '../shared/session.ts';
import type { SpeechSession } from '../shared/session.ts';
import { abortable, pause } from './async.ts';

export interface AudioQueue { readonly chunks: readonly Uint8Array[]; readonly sealed: boolean; readonly bytes: number }
export type OpenSocket = (url: string) => WebSocket;

export function transcriptionPrompt(context?: string): string {
  if (!context) return '';
  if ([...context].length > MAX_CONTEXT_POINTS) throw new SpeechError('CONTEXT_INVALID', '语音上下文超过长度上限。');
  return `Reference vocabulary:\n${context}`;
}

export async function transcribe(
  session: SpeechSession, context: string | undefined, audio: AudioQueue,
  signal: AbortSignal, committed: () => void,
  open: OpenSocket = url => new WebSocket(url, ['realtime']),
): Promise<string> {
  signal.throwIfAborted();
  const credential = parseSession(session);
  const prompt = transcriptionPrompt(context);
  const url = new URL(credential.socketUrl);
  url.searchParams.set('Authorization', `Bearer ${credential.clientSecret}`);
  const failure = new AbortController();
  const combined = AbortSignal.any([signal, failure.signal]);
  let socket: WebSocket | undefined;
  let commitSent = false;
  let itemId: string | undefined;
  let final: { item: string; text: string } | undefined;
  let resolveOpen!: () => void, resolveConfigured!: () => void, resolveFinal!: (value: string) => void;
  const opened = new Promise<void>(resolve => { resolveOpen = resolve; });
  const configured = new Promise<void>(resolve => { resolveConfigured = resolve; });
  const completed = new Promise<string>(resolve => { resolveFinal = resolve; });
  const fail = (code: string, message: string) => failure.abort(new SpeechError(code, message));
  const settle = () => {
    if (!itemId || !final) return;
    if (final.item !== itemId) fail('RESULT_MISMATCH', 'Azure 返回了不属于本次提交的转写结果。');
    else resolveFinal(final.text);
  };
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    socket = open(url.toString());
    socket.onopen = () => resolveOpen();
    socket.onclose = () => fail('CONNECTION_CLOSED', '语音连接已断开，可重试已保留的录音。');
    socket.onerror = () => fail('CONNECTION_FAILED', '无法连接 Azure，请检查网络后重试。');
    socket.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > MAX_RESPONSE_BYTES) throw new Error('size');
        const value: unknown = JSON.parse(event.data);
        if (!isRecord(value) || typeof value.type !== 'string') throw new Error('event');
        if (value.type === 'error' || value.type === 'conversation.item.input_audio_transcription.failed') {
          const code = isRecord(value.error) ? value.error.code : undefined;
          if (code === 'RateLimitReached' || code === 'rate_limit_exceeded') fail('RATE_LIMIT', 'Azure 请求限流，请稍后重试这段录音。');
          else fail('TRANSCRIPTION_FAILED', 'Azure 拒绝了连接或转写请求，请重试。');
        } else if (value.type === 'session.updated') {
          const input = isRecord(value.session) && isRecord(value.session.audio) ? value.session.audio.input : undefined;
          if (!isRecord(input) || input.turn_detection !== null || !isRecord(input.format)
            || input.format.type !== 'audio/pcm' || input.format.rate !== 24000
            || !isRecord(input.transcription) || input.transcription.model !== credential.deployment
            || input.transcription.prompt !== prompt) throw new Error('configuration');
          resolveConfigured();
        } else if (value.type === 'input_audio_buffer.committed') {
          if (!commitSent || typeof value.item_id !== 'string' || !value.item_id || (itemId && itemId !== value.item_id)) throw new Error('commit');
          itemId = value.item_id; settle();
        } else if (value.type === 'conversation.item.input_audio_transcription.completed') {
          if (!commitSent || typeof value.item_id !== 'string' || !value.item_id || value.content_index !== 0
            || typeof value.transcript !== 'string' || !value.transcript.trim() || [...value.transcript].length > MAX_TEXT_POINTS) {
            throw new Error('transcript');
          }
          final = { item: value.item_id, text: value.transcript }; settle();
        }
      } catch { fail('PROTOCOL_FAILED', 'Azure 返回了无效的配置或转写结果，可重试录音。'); }
    };
    setupTimer = setTimeout(() => fail('CONNECTION_TIMEOUT', '建立语音连接超时，可重试已保留的录音。'), 30_000);
    await abortable(opened, combined);
    socket.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: credential.deployment, prompt }, turn_detection: null,
    } } } }));
    await abortable(configured, combined);
    clearTimeout(setupTimer);
    let cursor = 0;
    while (!audio.sealed || cursor < audio.chunks.length) {
      combined.throwIfAborted();
      if (cursor === audio.chunks.length) { await pause(20, combined); continue; }
      const until = Date.now() + 30_000;
      while (socket.bufferedAmount > 64 * 1024) {
        if (Date.now() >= until) throw new SpeechError('UPLOAD_TIMEOUT', '发送录音超时，可重试已保留的录音。');
        await pause(20, combined);
      }
      socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(String.fromCharCode(...audio.chunks[cursor]!)) }));
      cursor++;
    }
    combined.throwIfAborted();
    if (audio.bytes < 4800) throw new SpeechError('AUDIO_TOO_SHORT', '录音不足 0.1 秒，请重新录音。');
    commitSent = true;
    finalTimer = setTimeout(() => fail('TRANSCRIPTION_TIMEOUT', '等待转写结果超时，可重试已保留的录音。'), 90_000);
    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    committed();
    return await abortable(completed, combined);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('CONNECTION_FAILED', '语音连接失败，可重试已保留的录音。');
  } finally {
    clearTimeout(setupTimer); clearTimeout(finalTimer);
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close();
    }
  }
}
