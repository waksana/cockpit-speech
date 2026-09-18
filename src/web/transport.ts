import { isRecord, MAX_RESPONSE_BYTES, MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';

export type Request = (path: string, init?: RequestInit) => Promise<Response>;
export type Transcribe = (audio: Uint8Array<ArrayBuffer>, context: string | undefined, signal: AbortSignal) => Promise<string>;

async function moduleResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new SpeechError('HTTP_FAILED', '语音模块返回了空响应。');
  const reader = response.body.getReader();
  let size = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let value: unknown;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value: bytes, done } = await reader.read();
      if (done) break;
      size += bytes.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('limit');
      text += decoder.decode(bytes, { stream: true });
    }
    value = JSON.parse(text + decoder.decode());
  } catch {
    signal.throwIfAborted();
    throw new SpeechError('HTTP_FAILED', '语音模块返回了无效或过大的响应。');
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  signal.throwIfAborted();
  if (!response.ok) {
    const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
    if (error && typeof error.code === 'string' && typeof error.message === 'string' && error.message.length <= 1500) {
      throw new SpeechError(error.code, error.message);
    }
    throw new SpeechError('HTTP_FAILED', `语音请求失败（HTTP ${response.status}）。`);
  }
  return value;
}

export function readinessClient(request: Request): (signal: AbortSignal) => Promise<void> {
  return async signal => {
    const deadline = AbortSignal.timeout(10_000);
    const combined = AbortSignal.any([signal, deadline]);
    try {
      combined.throwIfAborted();
      const response = await request('/config-ready', { method: 'GET', signal: combined });
      const value = await moduleResponse(response, combined);
      if (!isRecord(value) || value.ready !== true) throw new SpeechError('CONFIG_INVALID', '语音配置检查未成功，请检查 azure-speech.json。');
    } catch (error) {
      signal.throwIfAborted();
      if (deadline.aborted) throw new SpeechError('CONFIG_TIMEOUT', '语音配置检查超时，未开始录音，请稍后重试。');
      if (error instanceof SpeechError) throw error;
      throw new SpeechError('HTTP_FAILED', '无法连接语音模块检查配置，未开始录音，请检查连接后重试。');
    }
  };
}

export function transcriptionClient(request: Request): Transcribe {
  return async (audio, context, signal) => {
    let binary = '';
    for (let offset = 0; offset < audio.length; offset += 8192) binary += String.fromCharCode(...audio.subarray(offset, offset + 8192));
    let response: Response;
    try {
      response = await request('/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: btoa(binary), mime: 'audio/wav', ...(context ? { context } : {}) }), signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new SpeechError('HTTP_FAILED', '无法连接语音模块，请检查连接后重试。');
    }
    const value = await moduleResponse(response, signal);
    if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim() || [...value.text].length > MAX_TEXT_POINTS) {
      throw new SpeechError('HTTP_FAILED', '语音转写没有返回可用文字。');
    }
    return value.text;
  };
}
