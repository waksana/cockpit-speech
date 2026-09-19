import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatWindowMessage, ChatWindowSnapshot, HostSnapshot } from '@cockpit/module-api';
import { askContext, recentContext } from './context.ts';

const host: HostSnapshot = { sessionId: 's', visible: true, connected: true };
const message = (text: string, patch: Partial<ChatWindowMessage> = {}): ChatWindowMessage => ({
  id: `ui-${text}`, origin: { sessionId: 's', messageId: `native-${text}` }, role: 'assistant', text, complete: true, children: [], ...patch,
});
const snapshot = (messages: ChatWindowMessage[], patch: Partial<ChatWindowSnapshot> = {}): ChatWindowSnapshot => ({
  sessionId: 's', status: 'ready', hasMore: true, partial: true, messages, ...patch,
});
test('context takes only newest eligible root, with native origin, no inferred child chronology', () => {
  const window = snapshot([
    message('old'), message('eligible 😀', { children: [message('child')] }),
    message('streaming', { complete: false }), message('skill', { subtype: 'skill' }),
    message('ask', { subtype: 'ask-reply' }), message('subagent', { subtype: 'subagent' }),
    message('no origin', { origin: null }), message('other session', { origin: { sessionId: 'x', messageId: 'id' } }),
    message('agent', { origin: { sessionId: 's', messageId: 'id', agentId: 'agent' } }),
    message('missing id', { origin: { sessionId: 's', messageId: '' } }),
    message('user', { role: 'user' }), message('tool', { role: 'tool' }), message('  '),
  ]);
  assert.equal(recentContext(host, window, 's'), 'eligible 😀');
});
test('context keeps the last 1,000 Unicode code points without splitting supplementary characters', () => {
  const tail = '😀'.repeat(995) + '末尾end';
  assert.equal([...tail].length, 1_000);
  assert.equal(recentContext(host, snapshot([message(`discard this prefix${tail}`)]), 's'), tail);
  assert.equal(recentContext(host, snapshot([message(`  ${tail}  `)]), 's'), tail);
  assert.equal(recentContext(host, snapshot([message('a'.repeat(1_000) + 'z')]), 's'), 'a'.repeat(999) + 'z');
  assert.equal(recentContext(host, snapshot([message(' short reply 😀 ')]), 's'), 'short reply 😀');
});
test('context is optional, never fetched or taken from a stale window', () => {
  for (const status of ['unavailable', 'loading', 'stale', 'error'] as const) {
    assert.equal(recentContext(host, snapshot([message('x')], { status }), 's'), undefined);
  }
  assert.equal(recentContext({ ...host, connected: false }, snapshot([message('x')]), 's'), undefined);
  assert.equal(recentContext(host, snapshot([message('x')], { sessionId: 'other' }), 's'), undefined);
  assert.equal(recentContext(host, snapshot([]), 's'), undefined);
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
