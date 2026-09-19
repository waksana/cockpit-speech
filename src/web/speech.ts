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
  elapsedSeconds: number;
  holdingAtLimit: boolean;
  level: number;
  error: string | null;
  notice: string | null;
  recovery: Recovery | null;
  focus: { id: string; revision: number; selection: Selection } | null;
}
interface Operation {
  identity: Identity; draft: ModuleDraft; revision: number; selection: Selection; text: string;
  controller: AbortController; release(): void; unsubscribe(): void;
  state: SpeechSnapshot; recording?: Recording; context?: string;
  preparation?: RecordingPreparation; limited?: boolean; completion?: object;
  leaseId?: string;
  transcript: string;
  appliedText?: string;
  conflicted: boolean;
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
const idle: SpeechSnapshot = { phase: 'idle', elapsedSeconds: 0, holdingAtLimit: false,
  level: 0, error: null, notice: null, recovery: null, focus: null };

export function insertText(text: string, addition: string, selection: Selection): string {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  return text.slice(0, start) + addition + text.slice(end);
}

export class SpeechService {
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<string, Operation>();
  private target: Target | null = null;
  private capture: Operation | null = null;
  private view: SpeechSnapshot = idle;
  private disposed = false;
  private readonly options: SpeechOptions;
  private readonly unsubscribe: () => void;
  constructor(options: SpeechOptions) {
    this.options = options;
    this.unsubscribe = options.host.subscribe(() => {
      if (this.capture && !this.hostReady(this.capture.identity.sessionId)) this.interrupt(this.capture.identity.id);
      this.notify();
    });
    options.signal.addEventListener('abort', this.dispose, { once: true });
    if (options.signal.aborted) this.dispose();
  }
  getSnapshot = (id = this.target?.draft.id): SpeechSnapshot =>
    (id ? this.operations.get(id)?.state : undefined) ?? (id === this.target?.draft.id ? this.view : idle);
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify(): void {
    const visible = this.target && this.operations.get(this.target.draft.id);
    if (visible) visible.state = { ...visible.state };
    else this.view = { ...this.view };
    for (const listener of this.listeners) listener();
  }
  private update(operation: Operation, change: Partial<SpeechSnapshot>): void {
    if (!this.current(operation)) return;
    operation.state = { ...operation.state, ...change };
    this.notify();
  }
  private hostReady(sessionId: string): boolean {
    const host = this.options.host.getSnapshot();
    return host.connected && host.visible && host.sessionId === sessionId;
  }
  setTarget(target: Target): void {
    if (this.disposed) return;
    if (this.capture && (!matches(this.capture.identity, identity(target.draft)) || target.disabled || target.sendBlocked)) {
      this.interrupt(this.capture.identity.id);
    }
    if (this.target?.draft.id !== target.draft.id) this.view = idle;
    this.target = target;
    this.notify();
  }
  clearTarget(id: string): void {
    if (this.target?.draft.id !== id) return;
    this.target = null;
    this.view = idle;
    const operation = this.operations.get(id);
    if (operation) {
      this.update(operation, { focus: null });
      this.interrupt(id);
    }
    this.notify();
  }
  focusTarget(selection?: Selection, id = this.target?.draft.id): void {
    const target = this.target;
    if (!target || target.draft.id !== id || target.disabled || !this.hostReady(target.draft.sessionId)) return;
    this.view = { ...idle, focus: { id: target.draft.id, revision: target.draft.getSnapshot().revision, selection: selection ?? target.selection() } };
    this.notify();
  }
  canStart(id = this.target?.draft.id): boolean {
    if (this.disposed || this.capture || !id || this.operations.has(id) || this.target?.draft.id !== id) return false;
    return this.writable(this.target);
  }
  private writable(target: Target): boolean {
    const draft = target.draft.getSnapshot();
    return !target.disabled && !target.sendBlocked && this.hostReady(target.draft.sessionId)
      && !draft.retired && !draft.pending && !draft.unconfirmed && draft.blocks.length === 0;
  }
  private current(operation: Operation): boolean {
    return !this.disposed && this.operations.get(operation.identity.id) === operation && !operation.controller.signal.aborted;
  }
  ownsDraft(id: string): boolean {
    const operation = this.operations.get(id);
    if (!operation || operation.conflicted || operation.appliedText === undefined) return false;
    const snapshot = operation.draft.getSnapshot();
    return snapshot.revision === operation.revision && snapshot.text === operation.appliedText;
  }
  private captureLease(operation: Operation): void {
    const blocks = operation.draft.getSnapshot().blocks;
    operation.leaseId = blocks.length === 1 ? blocks[0]!.id : undefined;
  }
  private writeTranscript(operation: Operation, text: string): void {
    if (!this.current(operation) || operation.state.phase === 'retry' || operation.state.phase === 'idle') return;
    operation.transcript = text;
    if (operation.conflicted) return;
    try {
      const snapshot = operation.draft.getSnapshot();
      const target = this.target;
      const gated = target && matches(operation.identity, identity(target.draft)) && (target.disabled || target.sendBlocked);
      if (gated || snapshot.retired || snapshot.revision !== operation.revision || snapshot.pending || snapshot.unconfirmed
        || snapshot.blocks.some(block => block.id !== operation.leaseId)) {
        operation.conflicted = true; return;
      }
      // Silence must not delete the original selection. An empty final can
      // also retract this attempt's provisional text without losing that selection.
      if (!text && operation.appliedText === undefined) return;
      const next = text ? insertText(operation.text, text, operation.selection) : operation.text;
      if (snapshot.text !== next) operation.draft.editText(next);
      const updated = operation.draft.getSnapshot();
      if (updated.text !== next || updated.revision !== snapshot.revision + (snapshot.text !== next ? 1 : 0)) {
        operation.conflicted = true; return;
      }
      operation.revision = updated.revision;
      operation.appliedText = next;
    } catch {
      operation.conflicted = true;
      this.error(operation, new SpeechError('DRAFT_CONFLICT', '无法修改原输入框，识别结果将保留供恢复。'));
    }
  }
  async start(mode: 'button' | 'hold' = 'button', id = this.target?.draft.id): Promise<void> {
    if (!this.canStart(id)) return;
    const target = this.target!;
    const snapshot = target.draft.getSnapshot();
    const operation: Operation = {
      identity: identity(target.draft), draft: target.draft, revision: snapshot.revision,
      text: snapshot.text, selection: target.selection(), controller: new AbortController(),
      release: () => {}, unsubscribe: () => {}, state: { ...idle, phase: 'permission' },
      transcript: '', conflicted: false,
    };
    this.operations.set(operation.identity.id, operation);
    this.capture = operation;
    operation.unsubscribe = operation.draft.subscribe(() => {
      if (operation.draft.getSnapshot().retired) {
        this.finish(operation);
        this.notify();
      }
    });
    this.view = idle;
    try {
      operation.context = recentContext(this.options.host.getSnapshot(), this.options.chatWindow.getSnapshot(), target.draft.sessionId);
      operation.release = target.draft.block('正在录音或转写，请完成后再发送。');
      this.captureLease(operation);
      // A synchronous host notification can retire or interrupt the owner while acquiring its lease.
      if (!this.current(operation)) { this.release(operation); return; }
      this.notify();
      operation.preparation = this.options.prepare(operation.controller.signal, error => this.fail(operation, error), () => {
        operation.limited = true;
        if (this.current(operation) && operation.state.phase === 'recording') {
          if (mode === 'hold') this.update(operation, { holdingAtLimit: true, elapsedSeconds: 120, level: 0 });
          else void this.stop(operation.identity.id);
        }
      });
      const recording = await operation.preparation.start(this.options.session, operation.context, {
        waitForStop: mode === 'hold',
        onLevel: (value, seconds) => {
          if (this.current(operation) && operation.state.phase === 'recording' && !operation.state.holdingAtLimit) {
            this.update(operation, { level: value, elapsedSeconds: Math.min(120, Math.floor(seconds)) });
          }
        },
        onText: text => this.writeTranscript(operation, text),
      });
      if (!this.current(operation)) { recording.cancel(); return; }
      operation.recording = recording;
      if (operation.state.phase !== 'permission') return;
      this.update(operation, { phase: 'recording' });
      if (operation.limited) {
        if (mode === 'hold') this.update(operation, { holdingAtLimit: true, elapsedSeconds: 120, level: 0 });
        else void this.stop(operation.identity.id);
      }
    } catch (error) { this.fail(operation, error); }
  }
  // Navigation ends capture; only explicit cancel/discard destroys a live draft's task.
  interrupt(id = this.target?.draft.id): void {
    const operation = id ? this.operations.get(id) : undefined;
    if (!operation) return;
    this.update(operation, { focus: null });
    if (operation.state.phase === 'permission') this.cancel(id);
    else if (operation.state.phase === 'recording') void this.stop(id);
  }
  async stop(id = this.target?.draft.id): Promise<void> {
    const operation = id ? this.operations.get(id) : undefined;
    if (!operation?.recording || operation.state.phase !== 'recording') return;
    await this.complete(operation, false);
  }
  canRetry(id = this.target?.draft.id): boolean {
    const operation = id ? this.operations.get(id) : undefined;
    return !!operation && operation.state.phase === 'retry' && !this.disposed && !!this.target && this.target.draft.id === id
      && this.writable(this.target) && (operation.recording ? operation.recording.retryable() : !this.capture);
  }
  async retry(id = this.target?.draft.id): Promise<void> {
    if (!this.canRetry(id)) return;
    const operation = this.operations.get(id!)!;
    if (!operation.recording) {
      this.finish(operation);
      await this.start('button', id);
      return;
    }
    try {
      operation.release = operation.draft.block('正在重试录音，请完成后再发送。');
      this.captureLease(operation);
    }
    catch (error) { this.fail(operation, error); return; }
    if (!this.current(operation)) { this.release(operation); return; }
    await this.complete(operation, true);
  }
  private async complete(operation: Operation, retry: boolean): Promise<void> {
    if (!operation.recording) return;
    const completion = operation.completion = {};
    const current = () => this.current(operation) && operation.completion === completion;
    this.update(operation, { phase: 'stopping', holdingAtLimit: false, level: 0, error: null, recovery: null });
    if (!current()) return;
    try {
      // stop() releases physical capture synchronously, before another draft may open the microphone.
      const result = operation.recording[retry ? 'retry' : 'stop'](() => {
        if (current()) this.update(operation, { phase: 'transcribing' });
      });
      if (this.capture === operation) this.capture = null;
      this.notify();
      const text = await result;
      if (!current()) return;
      this.update(operation, { phase: 'idle', recovery: { ...operation.identity, text } });
      this.release(operation);
      if (!current()) return;
      try {
        const target = this.target;
        const gated = target && matches(operation.identity, identity(target.draft)) && (target.disabled || target.sendBlocked);
        const next = text ? insertText(operation.text, text, operation.selection) : operation.text;
        if (gated || operation.conflicted || !operation.draft.editTextIfRevision(next, operation.revision)) {
          this.update(operation, { notice: '草稿已修改或暂时无法写入。识别结果和录音已保留，可复制或手动插入原输入框。' });
          return;
        }
        this.finish(operation);
        if (text) {
          const caret = Math.max(0, Math.min(operation.text.length, operation.selection.start)) + text.length;
          this.focusTarget({ start: caret, end: caret }, operation.identity.id);
        } else if (this.target?.draft.id === operation.identity.id) {
          this.view = { ...idle, notice: '未识别到语音，草稿未被替换。' };
        }
        this.notify();
      } catch {
        this.error(operation, new SpeechError('DRAFT_CONFLICT', '无法修改原输入框，识别结果和录音已保留。'));
      }
    } catch (error) { if (current()) this.fail(operation, error); }
  }
  canInsert(id = this.target?.draft.id): boolean {
    const operation = id ? this.operations.get(id) : undefined;
    return !!operation?.state.recovery && !this.disposed && !!this.target && this.target.draft.id === id
      && (operation.state.phase === 'idle' || operation.state.phase === 'retry')
      && matches(operation.identity, identity(this.target.draft)) && this.writable(this.target);
  }
  insertRecovery(id = this.target?.draft.id): void {
    if (!this.canInsert(id)) return;
    const target = this.target!;
    const operation = this.operations.get(id!)!;
    const recovery = operation.state.recovery!;
    try {
      const snapshot = target.draft.getSnapshot();
      const start = Math.max(0, Math.min(snapshot.text.length, target.selection().start));
      if (!target.draft.editTextIfRevision(insertText(snapshot.text, recovery.text, { start, end: start }), snapshot.revision)) {
        throw new SpeechError('DRAFT_CONFLICT', '草稿已变化，请重新选择插入位置，或复制识别结果。');
      }
      this.finish(operation);
      const caret = start + recovery.text.length;
      this.focusTarget({ start: caret, end: caret }, id);
      this.notify();
    } catch { this.error(operation, new SpeechError('DRAFT_CONFLICT', '无法修改原输入框，请复制已保留的识别结果。')); }
  }
  dismiss(id = this.target?.draft.id): void { this.clear(id); }
  hasRetainedRecording(id = this.target?.draft.id): boolean { return !!(id && this.operations.get(id)?.recording); }
  clear(id = this.target?.draft.id): void {
    const operation = id ? this.operations.get(id) : undefined;
    if (operation) this.finish(operation);
    if (this.target?.draft.id === id) this.view = idle;
    this.notify();
  }
  notifyCopyFailure(id = this.target?.draft.id, recovery?: Recovery): void {
    const operation = id ? this.operations.get(id) : undefined;
    if (operation && (!recovery || operation.state.recovery === recovery)) {
      this.error(operation, new SpeechError('COPY_FAILED', '无法访问剪贴板，请手动选择并复制识别结果。'));
    }
  }
  private error(operation: Operation, error: unknown): void {
    const safe = error instanceof SpeechError ? error : new SpeechError('SPEECH_FAILED', '录音或转写失败，请稍后重试。');
    this.update(operation, { error: safe.message });
  }
  private finish(operation: Operation): void {
    if (this.operations.get(operation.identity.id) !== operation) return;
    this.operations.delete(operation.identity.id);
    if (this.capture === operation) this.capture = null;
    operation.unsubscribe();
    operation.controller.abort();
    operation.preparation?.cancel();
    operation.recording?.cancel();
    this.release(operation);
  }
  private release(operation: Operation): void {
    const release = operation.release;
    operation.release = () => {};
    release();
  }
  private fail(operation: Operation, error: unknown): void {
    if (!this.current(operation)) return;
    if (error instanceof SpeechError && error.code === 'AUDIO_TOO_SHORT') {
      this.finish(operation);
      if (this.target?.draft.id === operation.identity.id) this.view = idle;
      this.notify();
      return;
    }
    operation.completion = undefined;
    if (this.capture === operation) this.capture = null;
    this.release(operation);
    this.update(operation, { phase: 'retry', holdingAtLimit: false, level: 0,
      recovery: operation.conflicted && operation.transcript ? { ...operation.identity, text: operation.transcript } : null });
    this.error(operation, error);
  }
  cancel(id = this.target?.draft.id): void { this.clear(id); }
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    for (const operation of this.operations.values()) this.finish(operation);
    this.options.signal.removeEventListener('abort', this.dispose);
    this.unsubscribe();
    this.target = null;
    this.view = idle;
    this.listeners.clear();
  };
}
