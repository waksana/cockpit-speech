import { isRecord, MAX_RESPONSE_BYTES, MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';

export type Request = (path: string, init?: RequestInit) => Promise<Response>;
export type Transcribe = (audio: Uint8Array<ArrayBuffer>, context: string | undefined, signal: AbortSignal) => Promise<string>;

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
      throw new SpeechError('HTTP_FAILED', 'Speech transcription could not reach the module. Check the connection and try again.');
    }
    if (!response.body) throw new SpeechError('HTTP_FAILED', 'Speech transcription returned an empty response.');
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
      throw new SpeechError('HTTP_FAILED', 'Speech transcription returned an invalid or oversized response.');
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    signal.throwIfAborted();
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
      if (error && typeof error.code === 'string' && typeof error.message === 'string' && error.message.length <= 1500) {
        throw new SpeechError(error.code, error.message);
      }
      throw new SpeechError('HTTP_FAILED', `Speech transcription failed (HTTP ${response.status}).`);
    }
    if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim() || [...value.text].length > MAX_TEXT_POINTS) {
      throw new SpeechError('HTTP_FAILED', 'Speech transcription did not return usable text.');
    }
    return value.text;
  };
}
