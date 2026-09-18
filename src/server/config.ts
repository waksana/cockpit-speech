import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord, SpeechError } from '../shared/limits.ts';

export interface AzureConfig { endpoint: string; key: string }
const MAX_CONFIG_BYTES = 16 * 1024;
const guidance = '请在语音模块数据目录中创建或更新 azure-speech.json，仅填写字符串字段 endpoint 和 key。';

export function parseConfig(value: unknown): AzureConfig {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'endpoint,key'
    || typeof value.endpoint !== 'string' || typeof value.key !== 'string'
    || !value.key.trim() || value.key !== value.key.trim() || value.key.length > 1024
    || /[\x00-\x20\x7f]/.test(value.key)) {
    throw new SpeechError('CONFIG_INVALID', `语音配置无效或缺少 Key。${guidance}`, 503);
  }
  // Do not normalize a path, credentials, port or alternate Azure host into a trusted origin.
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cognitiveservices\.azure\.com\/?$/.test(value.endpoint)) {
    throw new SpeechError('CONFIG_ENDPOINT', `endpoint 必须是 https://<resource>.cognitiveservices.azure.com，不得包含路径、查询参数或凭据。${guidance}`, 503);
  }
  return { endpoint: value.endpoint.replace(/\/$/, ''), key: value.key };
}

export async function readConfig(dataRoot: string): Promise<AzureConfig> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = join(dataRoot, 'azure-speech.json');
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONFIG_BYTES) throw new Error('unsafe file');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('unsafe file');
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error('large file');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new SpeechError('CONFIG_INVALID', `azure-speech.json 必须是有效的 UTF-8 JSON。${guidance}`, 503); }
    return parseConfig(value);
  } catch (error) {
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('CONFIG_UNAVAILABLE', `无法读取 azure-speech.json，请确认文件存在、可读、不超过 16 KiB，且不是符号链接。${guidance}`, 503);
  } finally { await handle?.close(); }
}
