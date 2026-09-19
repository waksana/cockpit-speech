import type { ChatWindowSnapshot, DraftPurpose, HostSnapshot, ModuleDraft, ReadonlyState } from '@cockpit/module-api';
import { SpeechError } from '../shared/limits.ts';
import { recentContext } from './context.ts';
import type { Recording, RecordingPreparation, PrepareRecording } from './recorder.ts';
import type { CreateSession } from './transport.ts';

export interface Selection { start: number; end: number }
export interface Target { draft: ModuleDraft; disabled: boolean; sendBlocked: boolean; selection(): Selection }
interface Identity { id: string; sessionId: string; purpose: string }
export interface Recovery extends Identity { text: string }
export interface SpeechSnapshot {
  phase: 'idle' | 'permission' | 'recording' | 'stopping' | 'transcribing' | 'retry';
  error: string | null;
  notice: string | null;
  recovery: Recovery | null;
  focus: { id: string; revision: number; selection: Selection } | null;
}
interface Operation {
  identity: Identity; draft: ModuleDraft; revision: number; selection: Selection; text: string;
  controller: AbortController; release(): void; recording?: Recording; context?: string;
  preparation?: RecordingPreparation; limited?: boolean;
  completion?: object;
}
export interface SpeechOptions {
  signal: AbortSignal;
  host: ReadonlyState<HostSnapshot>;
  chatWindow: ReadonlyState<ChatWindowSnapshot>;
  prepare: PrepareRecording;
  session: CreateSession;
  report(error: Error): void;
}
const purposeKey = (purpose: DraftPurpose) => purpose.kind === 'prompt' ? 'prompt' : `${purpose.kind}:${purpose.requestId}`;
const identity = (draft: ModuleDraft): Identity => ({ id: draft.id, sessionId: draft.sessionId, purpose: purposeKey(draft.purpose) });
const matches = (a: Identity, b: Identity) => a.id === b.id && a.sessionId === b.sessionId && a.purpose === b.purpose;

export function insertText(text: string, addition: string, selection: Selection): string {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  return text.slice(0, start) + addition + text.slice(end);
}

export class SpeechService {
  private state: SpeechSnapshot = { phase: 'idle', error: null, notice: null, recovery: null, focus: null };
  private readonly listeners = new Set<() => void>();
  private target: Target | null = null;
  private operation: Operation | null = null;
  private disposed = false;
  private readonly options: SpeechOptions;
  private readonly unsubscribe: () => void;
  constructor(options: SpeechOptions) {
    this.options = options;
    this.unsubscribe = options.host.subscribe(() => {
      if (this.operation && !this.hostReady(this.operation.identity.sessionId)) this.cancel('会话、页面可见性或连接已变化，语音输入已取消。');
    });
    options.signal.addEventListener('abort', this.dispose, { once: true });
    if (options.signal.aborted) this.dispose();
  }
  getSnapshot = (): SpeechSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(change: Partial<SpeechSnapshot>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private hostReady(sessionId: string): boolean {
    const host = this.options.host.getSnapshot();
    return host.connected && host.visible && host.sessionId === sessionId;
  }
  setTarget(target: Target): void {
    if (this.disposed) return;
    this.target = target;
    if (this.operation && (!matches(this.operation.identity, identity(target.draft)) || target.disabled || target.sendBlocked)) {
      this.cancel('输入目标已变化或不再接受文字，语音输入已取消。');
    } else this.update({});
  }
  clearTarget(id: string): void {
    if (this.target?.draft.id !== id) return;
    this.target = null;
    this.update({ focus: null });
    if (this.operation) this.cancel('原输入框已关闭，语音输入已取消。');
    else if (!this.state.recovery) this.update({ phase: 'idle', error: null, notice: null });
  }
  focusTarget(selection?: Selection): void {
    const target = this.target;
    if (!target || target.disabled || !this.hostReady(target.draft.sessionId)) return;
    this.update({ focus: { id: target.draft.id, revision: target.draft.getSnapshot().revision, selection: selection ?? target.selection() } });
  }
  canStart(): boolean {
    if (this.disposed || this.operation || this.state.recovery || !this.target) return false;
    try { return this.writable(this.target); } catch { return false; }
  }
  private writable(target: Target): boolean {
    const draft = target.draft.getSnapshot();
    return !target.disabled && !target.sendBlocked && this.hostReady(target.draft.sessionId)
      && !draft.pending && !draft.unconfirmed && draft.blocks.length === 0;
  }
  private current(operation: Operation): boolean {
    return !this.disposed && this.operation === operation && !operation.controller.signal.aborted
      && !!this.target && matches(operation.identity, identity(this.target.draft)) && this.hostReady(operation.identity.sessionId);
  }
  async start(): Promise<void> {
    if (!this.canStart()) return;
    const target = this.target!;
    const snapshot = target.draft.getSnapshot();
    let operation: Operation;
    try {
      const context = recentContext(this.options.host.getSnapshot(), this.options.chatWindow.getSnapshot(), target.draft.sessionId);
      operation = {
        identity: identity(target.draft), draft: target.draft, revision: snapshot.revision,
        text: snapshot.text, selection: target.selection(), controller: new AbortController(),
        release: target.draft.block('正在录音或转写，请完成后再发送。'),
        context,
      };
    } catch {
      this.update({ phase: 'retry' });
      this.error(new SpeechError('DRAFT_UNAVAILABLE', '当前输入框已无法接受语音输入。'));
      return;
    }
    this.operation = operation;
    this.update({ phase: 'permission', error: null, notice: null, focus: null });
    try {
      operation.preparation = this.options.prepare(operation.controller.signal, error => this.fail(operation, error), () => {
        operation.limited = true;
        if (this.current(operation) && this.state.phase === 'recording') void this.stop();
      });
      const recording = await operation.preparation.start(this.options.session, operation.context);
      if (!this.current(operation)) { recording.cancel(); return; }
      operation.recording = recording;
      this.update({ phase: 'recording' });
      if (operation.limited) void this.stop();
    } catch (error) { this.fail(operation, error); }
  }
  async stop(): Promise<void> {
    const operation = this.operation;
    if (!operation?.recording || this.state.phase !== 'recording') return;
    await this.complete(operation, false);
  }
  canRetry(): boolean {
    if (this.state.phase !== 'retry' || !this.target || this.disposed) return false;
    try {
      return this.writable(this.target) && (!this.operation || (this.current(this.operation) && !!this.operation.recording?.retryable()));
    } catch { return false; }
  }
  async retry(): Promise<void> {
    if (!this.canRetry()) return;
    const operation = this.operation;
    if (!operation) { await this.start(); return; }
    try { operation.release = operation.draft.block('正在重试录音，请完成后再发送。'); }
    catch (error) { this.fail(operation, error); return; }
    await this.complete(operation, true);
  }
  private async complete(operation: Operation, retry: boolean): Promise<void> {
    if (!operation.recording) return;
    const completion = operation.completion = {};
    const current = () => this.current(operation) && operation.completion === completion;
    this.update({ phase: 'stopping', error: null });
    try {
      const text = await operation.recording[retry ? 'retry' : 'stop'](() => {
        if (current()) this.update({ phase: 'transcribing' });
      });
      if (!current()) return;
      this.finish(operation);
      const recovery = { ...operation.identity, text };
      this.update({ phase: 'idle', recovery });
      const target = this.target;
      try {
        if (!target || !matches(operation.identity, identity(target.draft)) || !this.writable(target)
          || target.draft.getSnapshot().revision !== operation.revision) {
          this.update({ notice: '草稿已修改或暂时无法写入。识别结果保留在下方，可复制或手动插入原输入框。' });
          return;
        }
        operation.draft.editText(insertText(operation.text, text, operation.selection));
        const caret = Math.max(0, Math.min(operation.text.length, operation.selection.start)) + text.length;
        this.focusTarget({ start: caret, end: caret });
        this.update({ recovery: null, notice: null });
      } catch {
        this.error(new SpeechError('DRAFT_CONFLICT', '无法修改原输入框，识别结果已保留在下方。'));
      }
    } catch (error) { if (current()) this.fail(operation, error); }
  }
  canInsert(): boolean {
    if (!this.state.recovery || !this.target || this.disposed || this.operation) return false;
    try { return matches(this.state.recovery, identity(this.target.draft)) && this.writable(this.target); } catch { return false; }
  }
  insertRecovery(): void {
    if (!this.canInsert()) return;
    const target = this.target!;
    const recovery = this.state.recovery!;
    try {
      // Explicit recovery inserts at the current caret, never deletes a user's selected text.
      const selection = target.selection();
      target.draft.editText(insertText(target.draft.getSnapshot().text, recovery.text, { start: selection.start, end: selection.start }));
      const caret = selection.start + recovery.text.length;
      this.focusTarget({ start: caret, end: caret });
      this.update({ recovery: null, error: null, notice: null });
    } catch { this.error(new SpeechError('DRAFT_CONFLICT', '无法修改原输入框，请复制已保留的识别结果。')); }
  }
  dismiss(): void {
    if (!this.operation) this.update({ recovery: null, error: null, notice: null });
  }
  notifyCopyFailure(): void { this.error(new SpeechError('COPY_FAILED', '无法访问剪贴板，请手动选择并复制识别结果。')); }
  private error(error: unknown): void {
    const safe = error instanceof SpeechError ? error : new SpeechError('SPEECH_FAILED', '录音或转写失败，请稍后重试。');
    this.update({ error: safe.message });
  }
  private finish(operation: Operation): void {
    if (this.operation !== operation) return;
    this.operation = null;
    operation.controller.abort();
    operation.preparation?.cancel();
    operation.recording?.cancel();
    this.release(operation);
  }
  private release(operation: Operation): void {
    const release = operation.release;
    operation.release = () => {};
    try { release(); } catch { /* Revocation already releases the module's leases. */ }
  }
  private fail(operation: Operation, error: unknown): void {
    if (this.operation !== operation) return;
    operation.completion = undefined;
    if (operation.recording?.retryable()) {
      this.release(operation);
    } else this.finish(operation);
    this.update({ phase: 'retry' });
    this.error(error);
  }
  cancel(_notice = '语音输入已取消。'): void {
    if (!this.operation) return;
    this.finish(this.operation);
    this.update({ phase: 'idle', notice: null, error: null });
  }
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.options.signal.removeEventListener('abort', this.dispose);
    this.unsubscribe();
    this.target = null;
    this.listeners.clear();
  };
}
