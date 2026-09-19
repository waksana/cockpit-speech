export function pcmLevel(buffer: ArrayBuffer): number {
  const samples = new DataView(buffer);
  let sum = 0;
  for (let offset = 0; offset < samples.byteLength; offset += 2) {
    const value = samples.getInt16(offset, true) / 32768;
    sum += value * value;
  }
  return samples.byteLength ? Math.sqrt(sum / (samples.byteLength / 2)) : 0;
}
