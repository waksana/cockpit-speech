export const PCM_RATE = 24_000;
export const PCM_LIMIT = PCM_RATE * 120;
export const PCM_CHUNK = 2400;

export class PcmEncoder {
  private previous = 0;
  private inputIndex = 0;
  private outputIndex = 0;
  private buffer = new ArrayBuffer(PCM_CHUNK * 2);
  private view = new DataView(this.buffer);
  private offset = 0;
  private readonly rate: number;
  private readonly emit: (buffer: ArrayBuffer) => void;
  constructor(rate: number, emit: (buffer: ArrayBuffer) => void) {
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error('Unsupported sample rate');
    this.rate = rate; this.emit = emit;
  }
  get full(): boolean { return this.outputIndex >= PCM_LIMIT; }
  push(input: Float32Array): void {
    for (const sample of input) {
      const current = Number.isFinite(sample) ? sample : 0;
      while (!this.full && this.outputIndex * this.rate / PCM_RATE <= this.inputIndex) {
        const fraction = this.inputIndex === 0 ? 1 : this.outputIndex * this.rate / PCM_RATE - this.inputIndex + 1;
        const value = Math.max(-1, Math.min(1, this.previous + (current - this.previous) * fraction));
        this.view.setInt16(this.offset * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        this.outputIndex++; this.offset++;
        if (this.offset === PCM_CHUNK) this.flush();
      }
      this.previous = current; this.inputIndex++;
      if (this.full) break;
    }
  }
  flush(): void {
    if (!this.offset) return;
    const bytes = this.offset === PCM_CHUNK ? this.buffer : this.buffer.slice(0, this.offset * 2);
    this.buffer = new ArrayBuffer(PCM_CHUNK * 2); this.view = new DataView(this.buffer); this.offset = 0;
    this.emit(bytes);
  }
}
