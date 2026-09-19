import { PcmEncoder } from './pcm.ts';

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private stopped = false;
  private readonly encoder = new PcmEncoder(sampleRate, buffer => this.port.postMessage({ type: 'pcm', buffer }, [buffer]));
  constructor() {
    super();
    this.port.onmessage = event => {
      if (event.data?.type === 'stop') this.finish(false);
    };
  }
  private finish(limited: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    this.encoder.flush();
    this.port.postMessage({ type: 'ended', limited });
  }
  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (input) this.encoder.push(input);
    if (this.encoder.full) this.finish(true);
    return !this.stopped;
  }
}
registerProcessor('cockpit-speech-capture', CaptureProcessor);
