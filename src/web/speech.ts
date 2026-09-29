import type { CapturedDraftSend, DraftPurpose, ModuleDraft } from '@waksana/cockpit-module-sdk/frontend';
import { SpeechError } from '../shared/limits.ts';
import { askContext, recentContext } from './context.ts';
import type { Recording, RecordingPreparation, PrepareRecording } from './recorder.ts';
import type { CreateSession } from './transport.ts';

export interface Selection { start: number; end: number }
export interface Target {
  draft: ModuleDraft; disabled: boolean; sendBlocked: boolean;
  available(): boolean;
  selection(): Selection;
}
interface Identity { id: string; purpose: string }
export interface Recovery extends Identity { text: string }
export interface SpeechSnapshot {
  phase: 'idle' | 'permission' | 'recording' | 'stopping' | 'transcribing' | 'retry' | 'sending' | 'send-error';
  sendRequested: boolean;
  sendOutcome: 'blocked' | 'rejected' | 'unconfirmed' | null;
  elapsedSeconds: number;
  holdingAtLimit: boolean;
  level: number;
  error: string | null;
  notice: string | null;
  recovery: Recovery | null;
  focus: { id: string; revision: number; selection: Selection; activate: boolean } | null;
}
interface Operation {
  identity: Identity; draft: ModuleDraft; revision: number; actionRevision: number; selection: Selection; text: string;
  controller: AbortController; release(): void; unsubscribe(): void;
  state: SpeechSnapshot; recording?: Recording; context?: string;
  preparation?: RecordingPreparation; limited?: boolean; completion?: object;
  leaseId?: string;
  transcript: string;
  appliedText?: string;
  conflicted: boolean;
  readonly mode: 'button' | 'hold';
  readonly focusOnCompletion: boolean;
  sendIntent?: CapturedDraftSend;
}
export interface SpeechOptions {
  signal: AbortSignal;
  prepare: PrepareRecording;
  session: CreateSession;
  report(error: Error): void;
}
const purposeKey = (purpose: DraftPurpose) => purpose.kind === 'prompt' ? 'prompt' : `${purpose.kind}:${purpose.requestId}`;
const identity = (draft: ModuleDraft): Identity => ({ id: draft.id, purpose: purposeKey(draft.purpose) });
const matches = (a: Identity, b: Identity) => a.id === b.id && a.purpose === b.purpose;
const idle: SpeechSnapshot = { phase: 'idle', sendRequested: false, sendOutcome: null, elapsedSeconds: 0, holdingAtLimit: false,
  level: 0, error: null, notice: null, recovery: null, focus: null };

export function insertText(text: string, addition: string, selection: Selection): string {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  return text.slice(0, start) + addition + text.slice(end);
}

export class SpeechService {
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<string, Operation>();
  private readonly targets = new Map<string, { target: Target; view: SpeechSnapshot; available: boolean }>();
  private capture: Operation | null = null;
  private disposed = false;
  private readonly options: SpeechOptions;
  constructor(options: SpeechOptions) {
    this.options = options;
    options.signal.addEventListener('abort', this.dispose, { once: true });
    if (options.signal.aborted) this.dispose();
  }
  private get target(): Target | undefined {
    return this.targets.size === 1 ? this.targets.values().next().value?.target : undefined;
  }
  getSnapshot = (id = this.target?.draft.id): SpeechSnapshot =>
    (id ? this.operations.get(id)?.state ?? this.targets.get(id)?.view : undefined) ?? idle;
  private setView(id: string, view: SpeechSnapshot): void {
    const entry = this.targets.get(id);
    if (entry) entry.view = view;
  }
  hasUnpersistedWork(): boolean {
    return [...this.operations.values()].some(operation =>
      !['idle', 'retry', 'send-error'].includes(operation.state.phase)
      || !!operation.recording || !!operation.state.recovery || operation.state.sendOutcome === 'unconfirmed');
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify(): void {
    for (const entry of this.targets.values()) entry.view = { ...entry.view };
    for (const operation of this.operations.values()) operation.state = { ...operation.state };
    for (const listener of this.listeners) listener();
  }
  private update(operation: Operation, change: Partial<SpeechSnapshot>): void {
    if (!this.current(operation)) return;
    operation.state = { ...operation.state, ...change };
    this.notify();
  }
  setTarget(target: Target): void {
    if (this.disposed) return;
    const previous = this.targets.get(target.draft.id);
    this.targets.set(target.draft.id, { target, view: previous?.view ?? idle, available: this.available(target) });
    if (this.capture?.identity.id === target.draft.id && !this.available(target)) {
      this.interrupt(this.capture.identity.id);
    }
    this.notify();
  }
  refreshTargets = (): void => {
    let changed = false;
    for (const entry of this.targets.values()) {
      const available = this.available(entry.target);
      if (entry.available !== available) {
        entry.available = available;
        changed = true;
      }
    }
    if (changed) this.notify();
  };
  clearTarget(id: string): void {
    this.targets.delete(id);
    const operation = this.operations.get(id);
    if (operation) {
      this.update(operation, { focus: null });
      this.interrupt(id);
    }
    this.notify();
  }
  focusTarget(selection?: Selection, id = this.target?.draft.id, activate = true): void {
    const target = id ? this.targets.get(id)?.target : undefined;
    if (!target || !this.available(target)) return;
    this.setView(target.draft.id, { ...idle, focus: { id: target.draft.id, revision: target.draft.getSnapshot().revision,
      selection: selection ?? target.selection(), activate } });
    this.notify();
  }
  canStart(id = this.target?.draft.id): boolean {
    if (this.disposed || this.capture || !id || this.operations.has(id)) return false;
    const target = this.targets.get(id)?.target;
    return !!target && this.writable(target);
  }
  private available(target: Target): boolean {
    const draft = target.draft.getSnapshot();
    return !target.disabled && !target.sendBlocked && target.available()
      && draft.editable && draft.submittable && !draft.retired;
  }
  private writable(target: Target): boolean {
    const draft = target.draft.getSnapshot();
    return this.available(target)
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
    if (!this.current(operation) || !['permission', 'recording', 'stopping', 'transcribing'].includes(operation.state.phase)) return;
    operation.transcript = text;
    if (operation.conflicted) return;
    try {
      const snapshot = operation.draft.getSnapshot();
      const target = this.targets.get(operation.identity.id)?.target;
      const gated = !operation.state.sendRequested && target
        && matches(operation.identity, identity(target.draft)) && (target.disabled || target.sendBlocked);
      if (gated || snapshot.actionRevision !== operation.actionRevision
        || !snapshot.editable || snapshot.retired || snapshot.revision !== operation.revision || snapshot.pending || snapshot.unconfirmed
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
  async start(mode: 'button' | 'hold' = 'button', id = this.target?.draft.id,
    options: { focusOnCompletion?: boolean } = {}): Promise<void> {
    if (!this.canStart(id)) return;
    const target = this.targets.get(id!)!.target;
    const snapshot = target.draft.getSnapshot();
    const operation: Operation = {
      identity: identity(target.draft), draft: target.draft, revision: snapshot.revision, actionRevision: snapshot.actionRevision,
      text: snapshot.text, selection: target.selection(), controller: new AbortController(),
      release: () => {}, unsubscribe: () => {}, state: { ...idle, phase: 'permission' },
      transcript: '', conflicted: false, mode, focusOnCompletion: options.focusOnCompletion ?? true,
    };
    this.operations.set(operation.identity.id, operation);
    this.capture = operation;
    operation.unsubscribe = operation.draft.subscribe(() => {
      const snapshot = operation.draft.getSnapshot();
      if (snapshot.retired) {
        this.finish(operation);
        this.notify();
      } else if (snapshot.actionRevision !== operation.actionRevision) {
        operation.conflicted = true;
        if (['permission', 'recording'].includes(operation.state.phase)) this.interrupt(operation.identity.id);
      }
    });
    this.setView(operation.identity.id, idle);
    try {
      operation.context = target.draft.purpose.kind === 'ask'
        ? askContext(snapshot.askContext)
        : recentContext(snapshot.referenceText);
      if (target.draft.purpose.kind === 'ask' && !operation.context) {
        operation.state = { ...operation.state, notice: '当前问题参考不可用，将仅根据录音转写。' };
      }
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
    operation.state = { ...operation.state, focus: null };
    if (operation.state.phase === 'permission') this.cancel(id);
    else if (operation.state.phase === 'recording') void this.stop(id);
    else this.notify();
  }
  async stop(id = this.target?.draft.id): Promise<void> {
    const operation = id ? this.operations.get(id) : undefined;
    if (!operation?.recording || operation.state.phase !== 'recording') return;
    await this.complete(operation, false);
  }
  async releaseHold(id = this.target?.draft.id): Promise<void> {
    const operation = id ? this.operations.get(id) : undefined;
    const target = id ? this.targets.get(id)?.target : undefined;
    if (!operation || operation.mode !== 'hold' || operation.state.phase !== 'recording') return;
    if (!target || !this.available(target) || operation.conflicted
      || operation.draft.getSnapshot().actionRevision !== operation.actionRevision) {
      this.interrupt(id);
      return;
    }
    // Capture consent before ending acquisition; later navigation cannot redirect or undo it.
    try { operation.sendIntent = operation.draft.captureSend(); }
    catch {
      this.update(operation, { sendOutcome: 'blocked' });
    }
    this.update(operation, { sendRequested: true });
    await this.stop(id);
  }
  canRetry(id = this.target?.draft.id): boolean {
    const operation = id ? this.operations.get(id) : undefined;
    const target = id ? this.targets.get(id)?.target : undefined;
    return !!operation && operation.state.phase === 'retry' && !this.disposed && !!target
      && this.writable(target) && (operation.recording ? operation.recording.retryable() : !this.capture);
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
        const target = this.targets.get(operation.identity.id)?.target;
        const gated = !operation.state.sendRequested && target
          && matches(operation.identity, identity(target.draft)) && (target.disabled || target.sendBlocked);
        const next = text ? insertText(operation.text, text, operation.selection) : operation.text;
        if (gated || operation.conflicted || operation.draft.getSnapshot().actionRevision !== operation.actionRevision
          || !operation.draft.editTextIfRevision(next, operation.revision)) {
          this.update(operation, { notice: '草稿已修改或暂时无法写入。识别结果和录音已保留，可复制或手动插入原输入框。' });
          return;
        }
        operation.revision++;
        if (operation.state.sendRequested && text.trim()) {
          await this.send(operation, text);
          return;
        }
        this.finish(operation);
        if (text && operation.focusOnCompletion) {
          const caret = Math.max(0, Math.min(operation.text.length, operation.selection.start)) + text.length;
          this.focusTarget({ start: caret, end: caret }, operation.identity.id, false);
        } else if (!text) {
          this.setView(operation.identity.id, { ...idle, notice: '未识别到语音，草稿未被替换。' });
        }
        this.notify();
      } catch {
        this.error(operation, new SpeechError('DRAFT_CONFLICT', '无法修改原输入框，识别结果和录音已保留。'));
      }
    } catch (error) { if (current()) this.fail(operation, error); }
  }
  private async send(operation: Operation, text: string): Promise<void> {
    if (!this.current(operation)) return;
    if (!operation.sendIntent) {
      this.sendFailed(operation, text, 'blocked');
      return;
    }
    this.update(operation, { phase: 'sending', recovery: null, error: null, notice: null });
    if (!this.current(operation)) return;
    try {
      const result = await operation.sendIntent.send(operation.revision);
      if (!this.current(operation)) return;
      if (result.status === 'acknowledged') {
        this.finish(operation);
        this.notify();
      } else this.sendFailed(operation, text, result.status);
    } catch {
      // Once dispatch was attempted, a thrown error cannot establish that nothing was sent.
      this.sendFailed(operation, text, 'unconfirmed');
    }
  }
  private sendFailed(operation: Operation, text: string, outcome: 'blocked' | 'rejected' | 'unconfirmed'): void {
    this.update(operation, { phase: 'send-error', sendOutcome: outcome,
      recovery: { ...operation.identity, text }, notice: null,
      error: outcome === 'blocked'
        ? '自动发送未执行。录音和文字已保留，请确认原草稿后使用原发送按钮。'
        : outcome === 'rejected' ? '原输入的接收方已拒绝发送。录音和文字已保留，请确认原草稿后使用原发送按钮。'
        : '发送结果未确认，可能已提交或本地确认未完成；不会自动重发。录音和文字已保留，请先检查原输入的提交记录。',
    });
  }
  canInsert(id = this.target?.draft.id): boolean {
    const operation = id ? this.operations.get(id) : undefined;
    const target = id ? this.targets.get(id)?.target : undefined;
    return !!operation?.state.recovery && !this.disposed && !!target
      && (operation.state.phase === 'idle' || operation.state.phase === 'retry')
      && matches(operation.identity, identity(target.draft))
      && target.draft.getSnapshot().actionRevision === operation.actionRevision && this.writable(target);
  }
  insertRecovery(id = this.target?.draft.id): void {
    if (!this.canInsert(id)) return;
    const target = this.targets.get(id!)!.target;
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
    if (id) this.setView(id, idle);
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
    operation.sendIntent?.cancel();
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
    if (!this.current(operation) || operation.state.phase === 'sending' || operation.state.phase === 'send-error') return;
    if (error instanceof SpeechError && error.code === 'AUDIO_TOO_SHORT') {
      this.finish(operation);
      this.setView(operation.identity.id, idle);
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
    this.targets.clear();
    this.listeners.clear();
  };
}
