import type { ChatWindowSnapshot, DraftAskContext, HostSnapshot } from '@cockpit/module-api';
import { MAX_CONTEXT_POINTS } from '../shared/limits.ts';

/** Question first, then ordered choices within the same total Unicode budget. */
export function askContext(ask: Readonly<DraftAskContext> | undefined): string | undefined {
  const question = ask?.question.trim();
  if (!question) return;
  let text = '';
  let remaining = MAX_CONTEXT_POINTS;
  const append = (value: string) => {
    for (const point of value) {
      if (!remaining) break;
      text += point;
      remaining--;
    }
  };
  append('Question: ');
  append(question);
  let first = true;
  for (const raw of ask?.choices ?? []) {
    const prefix = first ? '\nChoices:\n- ' : '\n- ';
    if (remaining <= prefix.length) break;
    const choice = raw.trim();
    if (!choice) continue;
    append(prefix);
    append(choice);
    first = false;
  }
  return text;
}

/** Module policy: the last 1,000 Unicode code points of the newest eligible root. */
export function recentContext(host: Readonly<HostSnapshot>, window: Readonly<ChatWindowSnapshot>, sessionId: string): string | undefined {
  if (!host.connected || !host.visible || host.sessionId !== sessionId || window.sessionId !== sessionId || window.status !== 'ready') return;
  for (let index = window.messages.length - 1; index >= 0; index--) {
    const message = window.messages[index]!;
    if (message.role === 'assistant' && message.complete && message.subtype === undefined
      && message.origin?.sessionId === sessionId && message.origin.messageId.trim()
      && message.origin.agentId === undefined && message.text.trim()) {
      return [...message.text.trim()].slice(-MAX_CONTEXT_POINTS).join('');
    }
  }
}
