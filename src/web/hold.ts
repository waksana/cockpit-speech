export const HOLD_DELAY = 300;
export const CANCEL_DISTANCE = 64;

export interface HoldPoint { pointerId: number; clientX: number; clientY: number }
export interface HoldSurface {
  setPointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
  releasePointerCapture(id: number): void;
}
interface HoldOptions {
  allowed(): boolean;
  bounds(): { left: number; right: number; top: number; bottom: number } | undefined;
  phase(): string;
  start(): void;
  stop(): void;
  cancel(): void;
  focus(): void;
}
interface Press {
  id: number;
  surface: HoldSurface;
  started: boolean;
  startY: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class HoldGesture {
  private press: Press | null = null;
  private pendingTap = false;
  private readonly options: HoldOptions;
  private readonly listeners = new Set<() => void>();
  constructor(options: HoldOptions) { this.options = options; }
  getSnapshot = (): boolean => this.press !== null;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify(): void { for (const listener of this.listeners) listener(); }
  private inside(point: HoldPoint): boolean {
    const bounds = this.options.bounds();
    return !!bounds && point.clientX >= bounds.left && point.clientX < bounds.right
      && point.clientY >= bounds.top && point.clientY < bounds.bottom;
  }
  down(point: HoldPoint & { button: number; isPrimary: boolean }, surface: HoldSurface): boolean {
    this.pendingTap = false;
    if (this.press) { this.cancel(); return false; }
    if (point.button !== 0 || !point.isPrimary || !this.options.allowed() || !this.inside(point)) return false;
    surface.setPointerCapture(point.pointerId);
    const press: Press = { id: point.pointerId, surface, started: false,
      startY: point.clientY };
    this.press = press;
    press.timer = setTimeout(() => {
      if (this.press !== press) return;
      if (!this.options.allowed()) { this.cancel(); return; }
      press.started = true;
      this.options.start();
    }, HOLD_DELAY);
    this.notify();
    return true;
  }
  move(point: HoldPoint): void {
    if (this.press?.id !== point.pointerId) return;
    if (point.clientY <= this.press.startY - CANCEL_DISTANCE) this.cancel();
  }
  up(point: HoldPoint): void {
    const press = this.press;
    if (!press || press.id !== point.pointerId) return;
    if (point.clientY <= press.startY - CANCEL_DISTANCE) { this.cancel(); return; }
    this.clear(press);
    if (!press.started) {
      this.pendingTap = this.options.allowed() && this.inside(point);
    } else if (this.options.phase() === 'recording') this.options.stop();
    else if (this.options.phase() !== 'retry') this.options.cancel();
  }
  click(): void {
    const tap = this.pendingTap;
    this.pendingTap = false;
    if (tap && this.options.allowed()) this.options.focus();
  }
  lost(id: number): void { if (this.press?.id === id) this.cancel(); }
  cancel = (): void => {
    this.pendingTap = false;
    const press = this.press;
    if (!press) return;
    this.clear(press);
    if (press.started) this.options.cancel();
  };
  private clear(press: Press): void {
    this.press = null;
    clearTimeout(press.timer);
    // Clear ownership before releasing capture: lostpointercapture must not cancel a completed release.
    if (press.surface.hasPointerCapture(press.id)) press.surface.releasePointerCapture(press.id);
    this.notify();
  }
}
