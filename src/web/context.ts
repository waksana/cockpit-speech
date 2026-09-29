import type { DraftAskContext } from '@waksana/cockpit-module-sdk/frontend';
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

/** The owner supplies already-visible reference text, never a history reader. */
export function recentContext(referenceText: string | undefined): string | undefined {
  const text = referenceText?.trim();
  return text ? [...text].slice(-MAX_CONTEXT_POINTS).join('') : undefined;
}
