// G.711 mu-law wire codec. No input contains WAV/RTP headers.
export function decodeMuLaw(input) {
  const output = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const u = ~input[i] & 255;
    let n = (((u & 15) << 3) + 132) << ((u & 112) >> 4);
    n -= 132;
    output.writeInt16LE(u & 128 ? -n : n, i * 2);
  }
  return output;
}
function encodeSample(sample) {
  let n = sample,
    mask = 255;
  if (n < 0) {
    n = -n;
    mask = 127;
  }
  n = Math.min(n, 32635) + 132;
  let exponent = 7;
  for (let bit = 16384; exponent > 0 && !(n & bit); bit >>= 1) exponent--;
  return ((exponent << 4) | ((n >> (exponent + 3)) & 15)) ^ mask;
}
export class MuLawEncoder {
  constructor(rate) {
    if (![8000, 16000, 24000, 48000].includes(rate))
      throw new Error("Unsupported output rate");
    this.factor = rate / 8000;
    this.carry = Buffer.alloc(0);
    this.wire = Buffer.alloc(0);
  }
  append(pcm) {
    const b = Buffer.concat([this.carry, pcm]);
    const frames = Math.floor(b.length / (2 * this.factor));
    const encoded = Buffer.alloc(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let j = 0; j < this.factor; j++)
        sum += b.readInt16LE((i * this.factor + j) * 2);
      encoded[i] = encodeSample(Math.round(sum / this.factor));
    }
    this.carry = b.subarray(frames * 2 * this.factor);
    this.wire = Buffer.concat([this.wire, encoded]);
    return this.drain(false);
  }
  drain(final) {
    if (final && this.carry.length) {
      this.carry = Buffer.alloc(0);
      throw new Error("Incomplete PCM sample group");
    }
    const messages = [];
    while (this.wire.length >= 160) {
      messages.push(this.wire.subarray(0, 160));
      this.wire = this.wire.subarray(160);
    }
    if (final && this.wire.length) {
      messages.push(
        Buffer.concat([this.wire, Buffer.alloc(160 - this.wire.length, 255)]),
      );
      this.wire = Buffer.alloc(0);
    }
    return messages;
  }
}
