export const SAMPLE_RATE = 16_000;
export const MAX_SECONDS = 120;
export const MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_JSON_BYTES = 15 * 1024 * 1024;
export const MAX_CONTEXT_POINTS = 200;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_TEXT_POINTS = 100_000;

export class SpeechError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function abortError(): Error {
  return new DOMException('Speech recording cancelled.', 'AbortError');
}
