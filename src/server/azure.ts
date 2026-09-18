import { isRecord, MAX_CONTEXT_POINTS, MAX_RESPONSE_BYTES, SpeechError } from '../shared/limits.ts';
import { parseSession } from '../shared/session.ts';
import type { SpeechSession } from '../shared/session.ts';
import type { AzureConfig } from './config.ts';

export interface SessionInput { context?: string }
export interface SessionIssuer {
  issue(config: AzureConfig, input: SessionInput, signal: AbortSignal): Promise<SpeechSession>;
}

export function parseInput(value: unknown): SessionInput {
  const invalid = () => new SpeechError('REQUEST_INVALID', `请求只允许可选 context（最多 ${MAX_CONTEXT_POINTS} 个 Unicode 字符），不接受音频、模型或凭据。`);
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'context')
    || (value.context !== undefined && (typeof value.context !== 'string'
      || value.context.length > MAX_CONTEXT_POINTS * 2 || [...value.context].length > MAX_CONTEXT_POINTS))) throw invalid();
  return typeof value.context === 'string' && value.context.trim() ? { context: value.context } : {};
}

export function definition(deployment: string, context?: string) {
  return {
    session: {
      type: 'transcription',
      audio: {
        input: {
          transcription: {
            model: deployment,
            // Azure caps the whole prompt at 1,024 code points, including this 22-point label.
            ...(context ? { prompt: `Reference vocabulary:\n${context}` } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
}

export async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new SpeechError('PROVIDER_RESPONSE', '转写响应超过大小上限。', 502);
  }
  if (!response.body) throw new SpeechError('PROVIDER_RESPONSE', '转写响应为空。', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new SpeechError('PROVIDER_RESPONSE', '转写响应超过大小上限。', 502);
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new SpeechError('PROVIDER_RESPONSE', 'Azure OpenAI 返回了无效 JSON。', 502); }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export function azureSessionIssuer(fetcher: typeof fetch = fetch, timeoutMs = 30_000): SessionIssuer {
  return {
    async issue(config, input, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      try {
        combined.throwIfAborted();
        const response = await fetcher(`${config.endpoint}/openai/v1/realtime/client_secrets`, {
          method: 'POST', headers: { 'api-key': config.key, 'Content-Type': 'application/json' },
          body: JSON.stringify(definition(config.deployment, input.context)), redirect: 'error', signal: combined,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) throw new SpeechError('PROVIDER_AUTH', 'Azure OpenAI 鉴权失败，请检查 azure-openai.json 的 endpoint、key 和资源权限。', 502);
          throw new SpeechError('PROVIDER_FAILED', `Azure OpenAI 短期凭据请求失败（HTTP ${response.status}），请检查 gpt-transcribe 部署；未自动重试。`, 502);
        }
        const value = await boundedJson(response);
        if (!isRecord(value) || !isRecord(value.session) || value.session.type !== 'transcription') {
          throw new SpeechError('PROVIDER_RESPONSE', 'Azure OpenAI 未创建纯转写会话。', 502);
        }
        const result = parseSession({
          clientSecret: value.value, expiresAt: value.expires_at,
          callsUrl: `${config.endpoint}/openai/v1/realtime/calls`,
        });
        combined.throwIfAborted();
        return result;
      } catch (error) {
        if (signal.aborted) throw new SpeechError('CANCELLED', '语音转写已取消。', 499);
        if (timeout.aborted) throw new SpeechError('PROVIDER_TIMEOUT', 'Azure OpenAI 短期凭据请求超时，未自动重试。', 504);
        if (error instanceof SpeechError) throw error;
        throw new SpeechError('PROVIDER_UNAVAILABLE', '无法安全连接 Azure OpenAI，请检查资源配置和网络；未自动重试。', 502);
      }
    },
  };
}
