// The AudioContext performs hardware-rate resampling to 16 kHz before this processor.
class SpeechPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.used = 0;
    this.total = 0;
    this.stopped = false;
    this.port.onmessage = event => {
      if (event.data === 'stop' && !this.stopped) {
        this.finish(false);
      }
    };
  }
  finish(limited) {
    if (this.stopped) return;
    this.stopped = true;
    this.flush();
    if (limited) this.port.postMessage({ type: 'limit' });
    this.port.postMessage({ type: 'done' });
  }
  flush() {
    if (!this.used) return;
    const chunk = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: 'chunk', samples: chunk }, [chunk.buffer]);
    this.used = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const length = Math.min(channels[0].length, 16000 * 120 - this.total);
    for (let index = 0; index < length; index++) {
      let mono = 0;
      for (const channel of channels) mono += channel[index] / channels.length;
      this.buffer[this.used++] = mono;
      if (this.used === this.buffer.length) this.flush();
    }
    this.total += length;
    if (this.total === 16000 * 120) { this.finish(true); return false; }
    return true;
  }
}
registerProcessor('cockpit-speech-pcm', SpeechPcmProcessor);
