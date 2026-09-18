import type { ChatWindowSnapshot, HostSnapshot } from '@cockpit/module-api';
import { MAX_CONTEXT_POINTS } from '../shared/limits.ts';

/** Module policy: the last eligible root, clipped to 200 Unicode code points. */
export function recentContext(host: Readonly<HostSnapshot>, window: Readonly<ChatWindowSnapshot>, sessionId: string): string | undefined {
  if (!host.connected || !host.visible || host.sessionId !== sessionId || window.sessionId !== sessionId || window.status !== 'ready') return;
  for (let index = window.messages.length - 1; index >= 0; index--) {
    const message = window.messages[index]!;
    if (message.role === 'assistant' && message.complete && message.subtype === undefined
      && message.origin?.sessionId === sessionId && message.origin.messageId.trim()
      && message.origin.agentId === undefined && message.text.trim()) {
      return [...message.text.trim()].slice(0, MAX_CONTEXT_POINTS).join('');
    }
  }
}
