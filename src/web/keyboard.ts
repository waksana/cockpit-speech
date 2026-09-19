interface KeyboardTarget {
  editor(): HTMLTextAreaElement | null;
  available(): boolean;
  empty(): boolean;
  canStart(): boolean;
  canContinue(): boolean;
  phase(): string;
  start(): void;
  release(): void;
  interrupt(): void;
  cancel(): void;
}

function visible(element: Element): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return style.visibility === 'visible' && style.display !== 'none'
    && element.getClientRects().length > 0;
}

/** Uses only the public editor ref and standard DOM/accessibility semantics. */
export function keyboardSurfaceAvailable(editor: HTMLTextAreaElement): boolean {
  const document = editor.ownerDocument;
  const window = document.defaultView!;
  if (!document.hasFocus() || document.visibilityState !== 'visible' || !visible(editor)
    || editor.disabled || editor.matches(':disabled') || editor.readOnly) return false;
  const rect = editor.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
  // showModal() makes the rest of the document inert without an inert attribute.
  for (const modal of document.querySelectorAll('dialog:modal')) {
    if (!modal.contains(editor)) return false;
  }
  return true;
}

const f8 = (event: KeyboardEvent) => event.key === 'F8';
const plain = (event: KeyboardEvent) => !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  && !event.isComposing && event.keyCode !== 229;

/** One listener set and one physical-key latch for every composer in an activation. */
export class KeyboardHold {
  private readonly targets = new Set<KeyboardTarget>();
  private owner: KeyboardTarget | null = null;
  private pressed = false;
  private composing = false;
  private detach?: () => void;

  register(target: KeyboardTarget, document: Document, window: Window): () => void {
    this.targets.add(target);
    if (!this.detach) {
      const visibility = () => { if (document.visibilityState !== 'visible') this.interrupt(); };
      const compositionStart = () => { this.composing = true; this.interrupt(); };
      const compositionEnd = () => { this.composing = false; };
      document.addEventListener('keydown', this.down, true);
      document.addEventListener('keyup', this.up, true);
      document.addEventListener('focusin', this.refresh);
      document.addEventListener('toggle', this.refresh, true);
      document.addEventListener('scroll', this.refresh, true);
      document.addEventListener('pointerdown', this.interrupt, true);
      document.addEventListener('compositionstart', compositionStart, true);
      document.addEventListener('compositionend', compositionEnd, true);
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('blur', this.interrupt);
      window.addEventListener('pagehide', this.interrupt);
      window.addEventListener('resize', this.interrupt);
      const observer = document.defaultView?.MutationObserver
        ? new document.defaultView.MutationObserver(this.refresh) : undefined;
      observer?.observe(document, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['hidden', 'inert', 'aria-hidden', 'style', 'class', 'open', 'disabled', 'readonly'] });
      this.detach = () => {
        document.removeEventListener('keydown', this.down, { capture: true });
        document.removeEventListener('keyup', this.up, { capture: true });
        document.removeEventListener('focusin', this.refresh);
        document.removeEventListener('toggle', this.refresh, true);
        document.removeEventListener('scroll', this.refresh, true);
        document.removeEventListener('pointerdown', this.interrupt, true);
        document.removeEventListener('compositionstart', compositionStart, true);
        document.removeEventListener('compositionend', compositionEnd, true);
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('blur', this.interrupt);
        window.removeEventListener('pagehide', this.interrupt);
        window.removeEventListener('resize', this.interrupt);
        observer?.disconnect();
      };
    }
    return () => {
      if (this.owner === target) this.interrupt();
      this.targets.delete(target);
      // Keep the key latch across input replacement, including a gap with no composer.
    };
  }
  private eligible(target: KeyboardTarget): boolean {
    const editor = target.editor();
    return !!editor && target.available() && keyboardSurfaceAvailable(editor);
  }
  refresh = (): void => {
    const owner = this.owner;
    if (owner && (!this.eligible(owner) || !owner.canContinue()
      || !['permission', 'recording'].includes(owner.phase()))) this.interrupt();
  };
  interrupt = (): void => {
    const owner = this.owner;
    this.owner = null;
    owner?.interrupt();
  };
  private down = (event: KeyboardEvent): void => {
    if (this.owner && event.key === 'Escape') {
      event.preventDefault();
      const owner = this.owner;
      this.owner = null;
      owner.cancel();
      return;
    }
    if (!f8(event)) { this.interrupt(); return; }
    if (this.pressed) {
      // A fresh down without the old up is not permission to release the old take.
      if (!event.repeat) this.interrupt();
      return;
    }
    if (event.repeat) return;
    this.pressed = true;
    if (event.defaultPrevented || !plain(event) || this.composing) return;
    const candidates = [...this.targets].filter(target => this.eligible(target));
    if (candidates.length !== 1) return;
    const target = candidates[0]!;
    if (!target.empty() || !target.canStart()) return;
    event.preventDefault();
    this.owner = target;
    target.start();
  };
  private up = (event: KeyboardEvent): void => {
    if (!f8(event)) return;
    this.pressed = false;
    const owner = this.owner;
    this.owner = null;
    if (!owner) return;
    const normal = !event.defaultPrevented && plain(event) && !this.composing
      && this.eligible(owner) && owner.canContinue();
    event.preventDefault();
    if (normal && owner.phase() === 'recording') owner.release();
    else if (owner.phase() === 'permission') owner.cancel();
    else owner.interrupt();
  };
  dispose = (): void => {
    this.interrupt();
    this.detach?.();
    this.detach = undefined;
    this.targets.clear();
    this.pressed = false;
    this.composing = false;
  };
}
