import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript } from './transcript.ts';
import { MAX_TEXT_POINTS } from '../shared/limits.ts';

test('all available item text is shown in committed order without waiting for earlier finals', () => {
  const transcript = new Transcript();
  transcript.commit('A', null); transcript.commit('B', 'A'); transcript.commit('C', 'B');
  transcript.delta('C', 'third');
  assert.equal(transcript.text, 'third');
  transcript.delta('A', 'fir'); transcript.delta('A', 'st ');
  assert.equal(transcript.text, 'first third');
  transcript.finish('C', 'third.');
  transcript.finish('B', 'second ');
  assert.equal(transcript.text, 'first second third.');
  assert.equal(transcript.complete, false);
  transcript.finish('A', 'First ');
  assert.equal(transcript.text, 'First second third.');
  assert.equal(transcript.complete, true);
  transcript.delta('A', 'late');
  transcript.commit('A', null);
  transcript.finish('A', 'First ');
  assert.equal(transcript.text, 'First second third.');
  transcript.seal();
});
test('item links support early text and out-of-order item registration, never UUID sorting', () => {
  const transcript = new Transcript();
  transcript.finish('aaa-later', 'later');
  assert.equal(transcript.text, '');
  assert.equal(transcript.complete, false);
  transcript.commit('aaa-later', 'zzz-first');
  transcript.commit('zzz-first', null);
  assert.equal(transcript.text, 'later');
  transcript.finish('zzz-first', 'first ');
  assert.equal(transcript.text, 'first later');
  assert.equal(transcript.complete, true);
});
test('empty finals replace provisional text and the empty recording is complete', () => {
  const transcript = new Transcript();
  assert.equal(transcript.complete, true);
  transcript.commit('A', null); transcript.delta('A', 'provisional');
  transcript.finish('A', '');
  assert.equal(transcript.text, '');
  assert.equal(transcript.complete, true);
});
test('conflicting, disconnected, cyclic and oversized results fail explicitly', () => {
  for (const previous of ['missing', 'B']) {
    const transcript = new Transcript();
    transcript.commit('A', previous);
    if (previous === 'B') transcript.commit('B', 'A');
    assert.throws(() => transcript.seal());
  }
  const transcript = new Transcript();
  assert.throws(() => transcript.commit('A', 'A'));
  transcript.commit('A', null);
  assert.throws(() => transcript.commit('A', 'other'));
  transcript.finish('A', 'final');
  assert.throws(() => transcript.finish('A', 'different'));
  transcript.commit('B', null);
  assert.throws(() => transcript.text);
  const bounded = new Transcript();
  bounded.delta('A', 'x'.repeat(MAX_TEXT_POINTS));
  assert.throws(() => bounded.delta('B', 'x'));
});
