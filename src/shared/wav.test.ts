import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeWav, validateWav } from './wav.ts';
import { MAX_SAMPLES } from './limits.ts';

test('WAV is canonical mono 16kHz PCM, with clipping and signed quantization', () => {
  const wav = encodeWav([new Float32Array([-2, -1, 0, 1, 2])], 5);
  validateWav(wav);
  assert.equal(wav.length, 54);
  assert.deepEqual([...new Int16Array(wav.buffer, 44)], [-32768, -32768, 0, 32767, 32767]);
});
test('WAV rejects empty, nonfinite, oversized, inconsistent or noncanonical audio', () => {
  assert.throws(() => encodeWav([], 0));
  assert.throws(() => encodeWav([], MAX_SAMPLES + 1));
  assert.throws(() => encodeWav([new Float32Array([1])], 2));
  assert.throws(() => encodeWav([new Float32Array([NaN])], 1));
  for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const wav = encodeWav([new Float32Array([0])], 1);
    wav[offset] = wav[offset]! ^ 1;
    assert.throws(() => validateWav(wav), `offset ${offset}`);
  }
});
