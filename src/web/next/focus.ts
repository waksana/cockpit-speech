/** Capture in React's ref cleanup, before DOM removal loses the active element. */
export class RemovedActionFocus {
  private removed: HTMLButtonElement | null = null;
  private readonly target: () => HTMLButtonElement | null;
  constructor(target: () => HTMLButtonElement | null) { this.target = target; }
  ref = (node: HTMLButtonElement | null): void | (() => void) => {
    if (!node) return;
    return () => {
      if (node.ownerDocument.activeElement === node) this.removed = node;
    };
  };
  restore = (): void => {
    const removed = this.removed;
    this.removed = null;
    if (!removed || removed.isConnected) return;
    const document = removed.ownerDocument;
    if (!document.hasFocus() || document.visibilityState !== 'visible'
      || (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement)) return;
    const target = this.target();
    if (!target || target.ownerDocument !== document || !target.isConnected || target.disabled || target.matches(':disabled')
      || target.getAttribute('aria-disabled') === 'true' || target.closest('[hidden], [inert], [aria-hidden="true"]')
      || !target.getClientRects().length
      || (target.checkVisibility && !target.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return;
    if (document.defaultView && document.defaultView.getComputedStyle(target).visibility !== 'visible') return;
    for (const modal of document.querySelectorAll('dialog:modal')) if (!modal.contains(target)) return;
    target.focus({ preventScroll: true });
  };
}
