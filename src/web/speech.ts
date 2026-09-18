import type { ChatWindowSnapshot, DraftPurpose, HostSnapshot, ModuleDraft, ReadonlyState } from '@cockpit/module-api';
import { SpeechError } from '../shared/limits.ts';
import { recentContext } from './context.ts';
import type { Recording, StartRecording } from './recorder.ts';
import type { Transcribe } from './transport.ts';

export interface Selection { start: number; end: number }
export interface Target { draft: ModuleDraft; disabled: boolean; sendBlocked: boolean; selection(): Selection }
interface Identity { id: string; sessionId: string; purpose: string }
export interface Recovery extends Identity { text: string }
export interface SpeechSnapshot {
  phase: 'idle' | 'permission' | 'recording' | 'stopping' | 'transcribing';
  error: string | null;
  notice: string | null;
  recovery: Recovery | null;
}
interface Operation {
  identity: Identity; draft: ModuleDraft; revision: number; selection: Selection; text: string;
  controller: AbortController; release(): void; recording?: Recording; context?: string;
}
export interface SpeechOptions {
  signal: AbortSignal;
  host: ReadonlyState<HostSnapshot>;
  chatWindow: ReadonlyState<ChatWindowSnapshot>;
  record: StartRecording;
  transcribe: Transcribe;
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
  private state: SpeechSnapshot = { phase: 'idle', error: null, notice: null, recovery: null };
  private readonly listeners = new Set<() => void>();
  private target: Target | null = null;
  private operation: Operation | null = null;
  private disposed = false;
  private readonly options: SpeechOptions;
  private readonly unsubscribe: () => void;
  constructor(options: SpeechOptions) {
    this.options = options;
    this.unsubscribe = options.host.subscribe(() => {
      if (this.operation && !this.hostReady(this.operation.identity.sessionId)) this.cancel('Recording cancelled because the session or connection changed.');
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
      this.cancel('Recording cancelled because its input target changed or no longer accepts text.');
    } else this.update({});
  }
  clearTarget(id: string): void {
    if (this.target?.draft.id !== id) return;
    this.target = null;
    this.cancel('Recording cancelled because its input was closed.');
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
        release: target.draft.block('Speech recording or transcription is in progress.'),
        context,
      };
    } catch { this.error(new SpeechError('DRAFT_UNAVAILABLE', 'This input can no longer accept a recording.')); return; }
    this.operation = operation;
    this.update({ phase: 'permission', error: null, notice: null });
    try {
      const recording = await this.options.record(operation.controller.signal, error => this.fail(operation, error));
      if (!this.current(operation)) { recording.cancel(); return; }
      operation.recording = recording;
      this.update({ phase: 'recording' });
    } catch (error) { this.fail(operation, error); }
  }
  async stop(): Promise<void> {
    const operation = this.operation;
    if (!operation?.recording || this.state.phase !== 'recording') return;
    this.update({ phase: 'stopping' });
    try {
      const audio = await operation.recording.stop();
      if (!this.current(operation)) return;
      this.update({ phase: 'transcribing' });
      const text = await this.options.transcribe(audio, operation.context, operation.controller.signal);
      if (!this.current(operation)) return;
      this.finish(operation);
      const recovery = { ...operation.identity, text };
      this.update({ phase: 'idle', recovery });
      const target = this.target;
      try {
        if (!target || !matches(operation.identity, identity(target.draft)) || !this.writable(target)
          || target.draft.getSnapshot().revision !== operation.revision) {
          this.update({ notice: 'Your draft changed or cannot accept text. The recognized text is retained below; copy it or explicitly insert it into the original input.' });
          return;
        }
        operation.draft.editText(insertText(operation.text, text, operation.selection));
        this.update({ recovery: null, notice: 'Speech inserted into the draft. Review it before sending.' });
      } catch {
        this.error(new SpeechError('DRAFT_CONFLICT', 'The original input could not be edited. The recognized text is retained below.'));
      }
    } catch (error) { this.fail(operation, error); }
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
      this.update({ recovery: null, error: null, notice: 'Speech inserted into the original draft. Review it before sending.' });
    } catch { this.error(new SpeechError('DRAFT_CONFLICT', 'The original input could not be edited. Copy the retained recognized text instead.')); }
  }
  dismiss(): void {
    if (!this.operation) this.update({ recovery: null, error: null, notice: null });
  }
  notifyCopyFailure(): void { this.error(new SpeechError('COPY_FAILED', 'Clipboard access failed. Select and copy the retained text manually.')); }
  private error(error: unknown): void {
    const safe = error instanceof SpeechError ? error : new SpeechError('SPEECH_FAILED', 'Speech recording or transcription failed. Try again when ready.');
    this.update({ error: safe.message });
    this.options.report(new Error(safe.message));
  }
  private finish(operation: Operation): void {
    if (this.operation !== operation) return;
    this.operation = null;
    operation.controller.abort();
    operation.recording?.cancel();
    try { operation.release(); } catch { /* Revocation already releases the module's leases. */ }
  }
  private fail(operation: Operation, error: unknown): void {
    if (this.operation !== operation) return;
    this.finish(operation);
    this.update({ phase: 'idle' });
    this.error(error);
  }
  cancel(notice = 'Speech recording or transcription cancelled.'): void {
    if (!this.operation) return;
    this.finish(this.operation);
    this.update({ phase: 'idle', notice, error: null });
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
