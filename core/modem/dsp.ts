/** Complex radix-2 FFT on Float64Array of 2n reals (re/im interleaved). */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error("FFT size must be power of two");
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) {
        if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      const a = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
  }

  /** Transform in place. inverse=true scales by 1/size. */
  transform(data: Float64Array, inverse = false): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (i < j) {
        const tr = data[2 * i];
        const ti = data[2 * i + 1];
        data[2 * i] = data[2 * j];
        data[2 * i + 1] = data[2 * j + 1];
        data[2 * j] = tr;
        data[2 * j + 1] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const w = j * step;
          const c = this.cos[w];
          const s = inverse ? -this.sin[w] : this.sin[w];
          const o1 = 2 * (i + j);
          const o2 = o1 + len;
          const re = data[o2] * c - data[o2 + 1] * s;
          const im = data[o2] * s + data[o2 + 1] * c;
          const r1 = data[o1];
          const i1 = data[o1 + 1];
          data[o2] = r1 - re;
          data[o2 + 1] = i1 - im;
          data[o1] = r1 + re;
          data[o1 + 1] = i1 + im;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < 2 * n; i++) data[i] /= n;
    }
  }
}

export function realFFTPairs(re: Float64Array, im: Float64Array, fft: FFT, inverse = false): Float64Array {
  const n = fft.size;
  const c = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    c[2 * i] = re[i];
    c[2 * i + 1] = im[i];
  }
  fft.transform(c, inverse);
  return c;
}

/** Linear cross-correlation of a signal block with a (reversed) kernel via FFT. */
export class Correlator {
  private readonly fft: FFT;
  private readonly kernelFreq: Float64Array;
  private readonly pad: Float64Array;
  readonly blockSize: number;

  constructor(kernel: Float64Array, blockSize: number) {
    const convLen = blockSize + kernel.length - 1;
    let size = 1;
    while (size < convLen) size <<= 1;
    this.fft = new FFT(size);
    this.blockSize = blockSize;
    this.pad = new Float64Array(2 * size);
    // FFT of the kernel
    this.kernelFreq = new Float64Array(2 * size);
    for (let i = 0; i < kernel.length; i++) {
      this.kernelFreq[2 * i] = kernel[i];
    }
    this.fft.transform(this.kernelFreq, false);
  }

  /**
   * Correlate kernel against `signal` (length blockSize). Returns the
   * cross-correlation on a grid matching the kernel length: result[i] is
   * correlation when kernel starts at sample i of the block (best delay).
   */
  correlate(signal: Float64Array, length: number): Float64Array {
    const size = this.fft.size;
    this.pad.fill(0);
    for (let i = 0; i < length; i++) this.pad[2 * i] = signal[i];
    this.fft.transform(this.pad, false);
    for (let i = 0; i < size; i++) {
      const re = this.pad[2 * i];
      const im = this.pad[2 * i + 1];
      const kRe = this.kernelFreq[2 * i];
      const kIm = this.kernelFreq[2 * i + 1];
      // X * conj(F)
      const cre = re * kRe + im * kIm;
      const cim = im * kRe - re * kIm;
      this.pad[2 * i] = cre;
      this.pad[2 * i + 1] = cim;
    }
    this.fft.transform(this.pad, true);
    const out = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      // circular correlation lag i (no wrap while length + kernelLen - 1 <= size)
      out[i] = this.pad[2 * i];
    }
    return out;
  }
}

export function rmsOf(data: Float64Array, from: number, to: number): number {
  let acc = 0;
  let n = 0;
  for (let i = from; i < to && i < data.length; i++) {
    acc += data[i] * data[i];
    n++;
  }
  return n ? Math.sqrt(acc / n) : 0;
}

/** Simple linear resampler (nearest linear interp) — good enough below 6 kHz band. */
export function resampleLinear(src: Float64Array, srcRate: number, dstRate: number): Float64Array {
  if (srcRate === dstRate) return src;
  const outLen = Math.floor((src.length * dstRate) / srcRate);
  const out = new Float64Array(outLen);
  const step = srcRate / dstRate;
  for (let i = 0; i < outLen; i++) {
    const p = i * step;
    const i0 = Math.floor(p);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const f = p - i0;
    out[i] = src[i0] * (1 - f) + src[i1] * f;
  }
  return out;
}

export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Raised-cosine edge window: flat in middle, smooth to zero at both ends. */
export function edgeWindow(n: number, rolloff = 0.1): Float64Array {
  const w = new Float64Array(n);
  const r = Math.max(1, Math.round((n * rolloff) / 2));
  for (let i = 0; i < n; i++) {
    let v = 1;
    if (i < r) v = 0.5 - 0.5 * Math.cos((Math.PI * i) / r);
    else if (i > n - 1 - r) v = 0.5 + 0.5 * Math.cos((Math.PI * (i - (n - 1 - r))) / r);
    w[i] = v;
  }
  return w;
}