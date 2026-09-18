import { MAX_AUDIO_BYTES, MAX_SAMPLES, SAMPLE_RATE, SpeechError } from './limits.ts';

export function encodeWav(chunks: readonly Float32Array[], samples: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(samples) || samples <= 0 || samples > MAX_SAMPLES
    || chunks.reduce((sum, chunk) => sum + chunk.length, 0) !== samples) {
    throw new SpeechError('AUDIO_LIMIT', '没有录到音频，或录音数据超过两分钟上限。');
  }
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    if (!Number.isFinite(sample)) throw new SpeechError('AUDIO_INVALID', '麦克风返回了无效音频。');
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
    offset += 2;
  }
  return bytes;
}

/** Accept only the single canonical mono PCM format produced by this module. */
export function validateWav(bytes: Uint8Array): void {
  const bad = () => new SpeechError('AUDIO_INVALID', '录音必须是非空的单声道 16 kHz、16 位 PCM WAV，时长不超过两分钟。');
  if (bytes.length < 46 || bytes.length > MAX_AUDIO_BYTES || bytes.length > 44 + MAX_SAMPLES * 2) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (text(0, 4) !== 'RIFF' || text(8, 12) !== 'WAVE' || text(12, 16) !== 'fmt '
    || text(36, 40) !== 'data' || view.getUint32(4, true) !== bytes.length - 8
    || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== SAMPLE_RATE
    || view.getUint32(28, true) !== SAMPLE_RATE * 2 || view.getUint16(32, true) !== 2
    || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== bytes.length - 44
    || (bytes.length - 44) % 2 !== 0) throw bad();
}
