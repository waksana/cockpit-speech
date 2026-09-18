import { isRecord, SpeechError } from './limits.ts';

export interface SpeechSession {
  clientSecret: string;
  expiresAt: number;
  callsUrl: string;
}

export function parseSession(value: unknown, now = Date.now()): SpeechSession {
  if (!isRecord(value) || typeof value.clientSecret !== 'string' || !value.clientSecret
    || value.clientSecret.length > 8192 || /[\x00-\x20\x7f]/.test(value.clientSecret)
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt * 1000 <= now
    || typeof value.callsUrl !== 'string'
    || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com\/openai\/v1\/realtime\/calls$/.test(value.callsUrl)) {
    throw new SpeechError('SESSION_INVALID', 'Azure OpenAI 未返回有效的短期连接凭据，请重新开始语音输入。', 502);
  }
  return { clientSecret: value.clientSecret, expiresAt: value.expiresAt, callsUrl: value.callsUrl };
}
