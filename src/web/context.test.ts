import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askContext, recentContext } from './context.ts';

test('context uses only reference text explicitly supplied by the draft owner', () => {
  assert.equal(recentContext(' owner-provided 😀 '), 'owner-provided 😀');
});
test('context keeps the last 1,000 Unicode code points without splitting supplementary characters', () => {
  const tail = '😀'.repeat(995) + '末尾end';
  assert.equal([...tail].length, 1_000);
  assert.equal(recentContext(`discard this prefix${tail}`), tail);
  assert.equal(recentContext(`  ${tail}  `), tail);
  assert.equal(recentContext('a'.repeat(1_000) + 'z'), 'a'.repeat(999) + 'z');
  assert.equal(recentContext(' short reply 😀 '), 'short reply 😀');
});
test('missing or blank owner context remains audio-only', () => {
  for (const text of [undefined, '', ' ', '\n\t']) assert.equal(recentContext(text), undefined);
});

test('ask context uses the question and ordered choices, not instructions to answer them', () => {
  assert.equal(askContext({ question: '  Choose a synthetic city?  ', choices: [' Alpha ', '😀 Beta', ' ', 'Gamma'] }),
    'Question: Choose a synthetic city?\nChoices:\n- Alpha\n- 😀 Beta\n- Gamma');
  assert.equal(askContext({ question: 'Freeform question?' }), 'Question: Freeform question?');
  assert.equal(askContext({ question: 'Freeform question?', choices: [] }), 'Question: Freeform question?');
  assert.equal(askContext({ question: 'Freeform question?', choices: [' ', '\n'] }), 'Question: Freeform question?');
  assert.equal(askContext(undefined), undefined);
  assert.equal(askContext({ question: ' ', choices: ['Not a substitute for the question'] }), undefined);
});
test('ask context bounds question, labels and choices together without splitting Unicode points', () => {
  const question = '😀'.repeat(990);
  assert.equal(askContext({ question: question + 'discard', choices: ['not enough room'] }), `Question: ${question}`);
  assert.equal(askContext({ question }), `Question: ${question}`);
  const result = askContext({ question: 'Q', choices: ['😀'.repeat(2_000), 'discard'] })!;
  assert.equal([...result].length, 1_000);
  assert.equal(result, 'Question: Q\nChoices:\n- ' + '😀'.repeat(977));
  const many = askContext({ question: 'Q', choices: Array.from({ length: 2_000 }, () => 'x') })!;
  assert.ok([...many].length <= 1_000);
  assert.ok(many.endsWith('x'), 'do not append a label without any choice text');
  assert.equal(askContext({ question: 'q'.repeat(978), choices: ['x'] }), 'Question: ' + 'q'.repeat(978),
    'a choice needs its complete label and at least one code point');
  assert.equal(askContext({ question: 'q'.repeat(977), choices: ['😀x'] }), 'Question: ' + 'q'.repeat(977) + '\nChoices:\n- 😀');
});
