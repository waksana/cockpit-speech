import { isRecord, MAX_RESPONSE_BYTES, SpeechError } from '../shared/limits.ts';
import { parseSession } from '../shared/session.ts';
import type { SpeechSession } from '../shared/session.ts';

export type Request = (path: string, init?: RequestInit) => Promise<Response>;
export type CreateSession = (signal: AbortSignal, refresh?: boolean) => Promise<SpeechSession>;

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

export function sessionClient(request: Request, lifetime?: AbortSignal): CreateSession {
  let cached: { session: SpeechSession; until: number } | undefined;
  lifetime?.addEventListener('abort', () => { cached = undefined; }, { once: true });
  return async (signal, refresh = false) => {
    signal.throwIfAborted();
    lifetime?.throwIfAborted();
    if (refresh) cached = undefined;
    if (cached && cached.until > Date.now()) return cached.session;
    const deadline = AbortSignal.timeout(35_000);
    const combined = AbortSignal.any([signal, deadline, ...(lifetime ? [lifetime] : [])]);
    try {
      combined.throwIfAborted();
      const response = await request('/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{}', signal: combined,
      });
      const value = await moduleResponse(response, combined);
      combined.throwIfAborted();
      const session = parseSession(value);
      // Bound stale on-disk configuration to one minute without checking it on every click.
      cached = { session, until: Math.min(Date.now() + 60_000, session.expiresAt * 1000 - 30_000) };
      return session;
    } catch (error) {
      signal.throwIfAborted();
      lifetime?.throwIfAborted();
      if (deadline.aborted) throw new SpeechError('SESSION_TIMEOUT', '获取语音连接凭据超时，可重试已保留的录音。');
      if (error instanceof SpeechError) throw error;
      throw new SpeechError('HTTP_FAILED', '无法连接语音模块获取短期凭据，请检查连接后重试。');
    }
  };
}
