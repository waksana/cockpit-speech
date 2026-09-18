import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatWindowMessage, ChatWindowSnapshot, HostSnapshot } from '@cockpit/module-api';
import { recentContext } from './context.ts';

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
test('context is optional, clipped by Unicode codepoint, never fetched or taken from a stale window', () => {
  assert.equal(recentContext(host, snapshot([message('😀'.repeat(201))]), 's'), '😀'.repeat(200));
  for (const status of ['unavailable', 'loading', 'stale', 'error'] as const) {
    assert.equal(recentContext(host, snapshot([message('x')], { status }), 's'), undefined);
  }
  assert.equal(recentContext({ ...host, connected: false }, snapshot([message('x')]), 's'), undefined);
  assert.equal(recentContext(host, snapshot([message('x')], { sessionId: 'other' }), 's'), undefined);
  assert.equal(recentContext(host, snapshot([]), 's'), undefined);
});
