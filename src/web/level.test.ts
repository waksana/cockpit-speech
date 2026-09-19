import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcmLevel } from './level.ts';

test('volume uses actual little-endian PCM RMS, from silence to full amplitude', () => {
  const buffer = new ArrayBuffer(8);
  assert.equal(pcmLevel(buffer), 0);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i++) view.setInt16(i * 2, i % 2 ? -16384 : 16384, true);
  assert.equal(pcmLevel(buffer), 0.5);
  for (let i = 0; i < 4; i++) view.setInt16(i * 2, -32768, true);
  assert.equal(pcmLevel(buffer), 1);
  assert.equal(pcmLevel(new ArrayBuffer(0)), 0);
});
