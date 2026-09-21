import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemovedActionFocus } from './focus.ts';

function fixture() {
  const body = {}, html = {};
  const document = {
    body, documentElement: html, activeElement: null as object | null,
    hasFocus: () => true, visibilityState: 'visible',
    defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
    querySelectorAll: () => [] as { contains(node: object): boolean }[],
  };
  let focused = 0, available = true;
  const action = {
    ownerDocument: document, isConnected: true, disabled: false,
    matches: () => false, getAttribute: () => null as string | null, closest: () => null as object | null,
    getClientRects: () => [{}], checkVisibility: () => true,
    focus(options: FocusOptions) { assert.equal(options.preventScroll, true); focused++; document.activeElement = action; },
  };
  const removed = { ownerDocument: document, isConnected: true };
  const tracker = new RemovedActionFocus(() => available ? action as unknown as HTMLButtonElement : null);
  const capture = () => {
    const cleanup = tracker.ref(removed as unknown as HTMLButtonElement);
    assert.equal(typeof cleanup, 'function');
    if (cleanup) cleanup();
  };
  const remove = () => { removed.isConnected = false; document.activeElement = body; };
  return { tracker, document, action, removed, capture, remove, focused: () => focused, unavailable: () => { available = false; } };
}

test('React ref cleanup remembers only owned focus and restores once after removal', () => {
  for (const name of ['retry', 'cancel', 'discard']) {
    const f = fixture();
    f.document.activeElement = f.removed;
    f.capture();
    f.remove();
    f.tracker.restore();
    assert.equal(f.document.activeElement, f.action, name);
    assert.equal(f.focused(), 1);
    f.tracker.restore();
    assert.equal(f.focused(), 1, 'later phase updates cannot move focus again');
  }
});

test('ordinary editing, other controls, still-mounted refs and invalid composers never lose focus', () => {
  for (const reason of ['not-owned', 'other-control', 'textarea', 'same-node', 'unavailable', 'disconnected',
    'disabled', 'fieldset', 'aria-disabled', 'inert', 'no-rect', 'invisible', 'css-hidden', 'page-hidden', 'window-blur', 'modal', 'other-document']) {
    const f = fixture();
    f.document.activeElement = reason === 'not-owned' ? {} : f.removed;
    f.capture(); f.remove();
    if (reason === 'other-control' || reason === 'textarea') f.document.activeElement = {};
    if (reason === 'same-node') { f.removed.isConnected = true; f.document.activeElement = f.removed; }
    if (reason === 'unavailable') f.unavailable();
    if (reason === 'disconnected') f.action.isConnected = false;
    if (reason === 'disabled') f.action.disabled = true;
    if (reason === 'fieldset') f.action.matches = () => true;
    if (reason === 'aria-disabled') f.action.getAttribute = () => 'true';
    if (reason === 'inert') f.action.closest = () => ({});
    if (reason === 'no-rect') f.action.getClientRects = () => [];
    if (reason === 'invisible') f.action.checkVisibility = () => false;
    if (reason === 'css-hidden') f.document.defaultView.getComputedStyle = () => ({ visibility: 'hidden' });
    if (reason === 'page-hidden') f.document.visibilityState = 'hidden';
    if (reason === 'window-blur') f.document.hasFocus = () => false;
    if (reason === 'modal') f.document.querySelectorAll = () => [{ contains: () => false }];
    if (reason === 'other-document') f.action.ownerDocument = { ...f.document };
    f.tracker.restore();
    assert.equal(f.focused(), 0, reason);
  }
});
