import { crc16 } from "../crc16.ts";
import { Correlator, edgeWindow, rmsOf } from "./dsp.ts";

export const CANONICAL_FS = 44100;
export const BAUD = 100;
export const SYMBOL_LEN_SAMPLES = Math.round(CANONICAL_FS / BAUD); // 441

export const CHIRP_F0 = 800;
export const CHIRP_F1 = 2000;
export const CHIRP_LEN = Math.round(0.15 * CANONICAL_FS); // 6615
const CHIRP_ENV = edgeWindow(CHIRP_LEN, 0.15);

const BARKER = [1, 1, 1, 1, 1, -1, -1, 1, 1, -1, 1, -1, 1];
const SYNC_CARRIER = 2; // 2000 Hz tone used for symbol sync
const GUARD = Math.round(0.02 * CANONICAL_FS);
const TRAIL = Math.round(0.05 * CANONICAL_FS);

export interface ModemParams {
  quiet?: boolean;
  rate?: 1 | 2 | 3;
  amplitude?: number;
}

interface FixedParams {
  quiet: boolean;
  rate: 1 | 2 | 3;
  carriers: number[];
  symbolLen: number;
  amplitude: number;
  payloadBytes: number;
}

export function resolveParams(p: ModemParams = {}): FixedParams {
  const quiet = !!p.quiet;
  // Orthogonal OFDM: spacing must be a multiple of fs/symbolLen.
  // Normal: 100 baud -> 441-sample symbols -> 100 Hz grid.
  // Quiet: 25 baud -> 1764-sample symbols -> 25 Hz grid.
  const carriers = quiet
    ? [1500, 1525, 1550, 1575]
    : Array.from({ length: 16 }, (_, i) => 1500 + i * 250);
  const symbolLen = quiet ? Math.round(CANONICAL_FS / 25) : SYMBOL_LEN_SAMPLES;
  return {
    quiet,
    rate: p.rate ?? 3,
    carriers,
    symbolLen,
    amplitude: p.amplitude ?? (quiet ? 0.3 : 0.8),
    payloadBytes: quiet ? 16 : 45,
  };
}

export interface ModemFrame {
  rate: 1 | 2 | 3;
  payload: Uint8Array;
}

const RATE = 3; // fixed 3× repetition FEC (frame length is deterministic both ends)

const ODD_BITS = (function () {
  const out = new Float64Array(CHIRP_LEN);
  for (let i = 0; i < CHIRP_LEN; i++) {
    const t = i / CANONICAL_FS;
    const phase = 2 * Math.PI * (CHIRP_F0 * t + ((CHIRP_F1 - CHIRP_F0) * t * t) / (2 * (CHIRP_LEN / CANONICAL_FS)));
    out[i] = 0.7 * CHIRP_ENV[i] * Math.sin(phase);
  }
  return out;
})();

export function chirpRef(): Float64Array {
  return ODD_BITS;
}


function mulInvModulo(a: number, m: number): number {
  let t = 0;
  let newT = 1;
  let r = m;
  let newR = a;
  while (newR !== 0) {
    const q = Math.floor(r / newR);
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1) throw new Error("not invertible");
  if (t < 0) t += m;
  return t;
}

export class Modulator {
  private readonly p: FixedParams;

  constructor(p: ModemParams = {}) {
    this.p = resolveParams(p);
  }

  private encodeFrame(frame: Uint8Array): { bits: Uint8Array } {
    const body = frame.slice(0, this.p.payloadBytes);
    const flag = (0 | (0 << 1) | (this.p.quiet ? 4 : 0)) & 0xff; // rate bits reserved (always 3)
    const head = new Uint8Array(body.length + 3);
    head[0] = flag;
    head.set(body, 1);
    new DataView(head.buffer).setUint16(head.length - 2, crc16(head.subarray(0, head.length - 2)), false);

    const rate = RATE;
    const total = head.length * 8 * rate;
    const bitsPerSymbol = this.p.carriers.length * 2;
    const symbols = Math.ceil(total / bitsPerSymbol);
    const N = symbols * bitsPerSymbol;
    const fec = new Uint8Array(N);
    for (let i = 0; i < head.length * 8; i++) {
      const bit = (head[i >> 3] >> (7 - (i & 7))) & 1;
      for (let r = 0; r < rate; r++) fec[rate * i + r] = bit;
    }
    // interleave: source bit n → transmit position (n*K) mod N
    let K = -1;
    for (let tryK = Math.floor(N / 2) + 1; tryK < N; tryK++) {
      if (gcd(N, tryK) === 1) {
        K = tryK;
        break;
      }
    }
    const inter = new Uint8Array(N);
    for (let n = 0; n < N; n++) inter[(n * K) % N] = fec[n];
    return { bits: inter };
  }

  /** Modulate one chunk payload into a complete frame waveform (unit samples). */
  modulate(payload: Uint8Array): Float64Array {
    if (payload.length !== this.p.payloadBytes) {
      throw new Error(`payload must be ${this.p.payloadBytes} bytes`);
    }
    const { bits } = this.encodeFrame(payload);
    const carriers = this.p.carriers;
    const bitsPerSymbol = carriers.length * 2;
    // First symbol is the DQPSK phase reference; data occupies the rest.
    const dataSymbols = bits.length / bitsPerSymbol;
    const payloadSymbols = dataSymbols + 1;
    const out = new Float64Array(GUARD + CHIRP_LEN + BARKER.length * this.p.symbolLen + payloadSymbols * this.p.symbolLen + TRAIL);
    const win = edgeWindow(this.p.symbolLen, 0.08);
    out.set(chirpRef(), GUARD);

    // Barker sync: BPSK on the sync carrier.
    let syncStart = GUARD + CHIRP_LEN;
    for (let s = 0; s < BARKER.length; s++) {
      const base = BARKER[s] > 0 ? 0 : Math.PI;
      const c0 = carriers[SYNC_CARRIER];
      const w0 = (2 * Math.PI * c0) / CANONICAL_FS;
      for (let i = 0; i < this.p.symbolLen; i++) {
        out[syncStart + s * this.p.symbolLen + i] += this.p.amplitude * win[i] * Math.sin(w0 * i + base);
      }
    }
    // Payload: DQPSK. Phase accumulates per carrier for spectral continuity.
    const phase = new Float64Array(carriers.length).fill(Math.PI / 4);
    let bitPos = 0;
    let payloadStart = syncStart + BARKER.length * this.p.symbolLen;
    for (let s = 0; s < payloadSymbols; s++) {
      const off = payloadStart + s * this.p.symbolLen;
      for (const [c, fc] of carriers.entries()) {
        const w0 = (2 * Math.PI * fc) / CANONICAL_FS;
        if (s > 0) {
          const b0 = bitPos < bits.length ? bits[bitPos] : 0;
          const b1 = bitPos + 1 < bits.length ? bits[bitPos + 1] : 0;
          bitPos += 2;
          const pair = (b0 << 1) | b1;
          phase[c] += (pair * Math.PI) / 2 + Math.PI / 4;
        }
        const ph = phase[c];
        for (let i = 0; i < this.p.symbolLen; i++) {
          out[off + i] += this.p.amplitude * win[i] * Math.sin(w0 * i + ph);
        }
      }
    }
    return out;
  }
}

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

const QPSK_DELTAS: Array<{ ph: number; b0: number; b1: number }> = [
  { ph: Math.PI / 4, b0: 0, b1: 0 },
  { ph: (3 * Math.PI) / 4, b0: 0, b1: 1 },
  { ph: (5 * Math.PI) / 4, b0: 1, b1: 0 },
  { ph: (7 * Math.PI) / 4, b0: 1, b1: 1 },
];

export function normAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function phaseToBits(delta: number): [number, number] {
  let best = QPSK_DELTAS[0];
  let bestD = Infinity;
  for (const q of QPSK_DELTAS) {
    const d = Math.abs(normAngle(delta - q.ph));
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return [best.b0, best.b1];
}

export class Demodulator {
  private readonly p: FixedParams;
  private readonly chirpCorr: Correlator;
  private readonly win: Float64Array;
  private readonly cosT: Float64Array[];
  private readonly sinT: Float64Array[];
  private buf: Float64Array = new Float64Array(0);
  private pos = 0;
  private skipLags: number[] = [];
  private _noiseFloor = 0;
  private _lastSnr = 0;
  private _framesDecoded = 0;
  private _syncFails = 0;
  private refPhase: Float64Array;

  constructor(quiet = false) {
    this.p = resolveParams({ quiet });
    this.chirpCorr = new Correlator(chirpRef(), 8192);
    this.win = edgeWindow(this.p.symbolLen, 0.08);
    this.refPhase = new Float64Array(this.p.carriers.length);
    this.cosT = [];
    this.sinT = [];
    for (const fc of this.p.carriers) {
      // pre-rotate table so the window is folded in: w[i] * e^{-j2πfc i/fs}
      const w0 = (2 * Math.PI * fc) / CANONICAL_FS;
      const ct = new Float64Array(this.p.symbolLen);
      const st = new Float64Array(this.p.symbolLen);
      for (let i = 0; i < this.p.symbolLen; i++) {
        ct[i] = this.win[i] * Math.cos(w0 * i);
        st[i] = this.win[i] * Math.sin(w0 * i);
      }
      this.cosT.push(ct);
      this.sinT.push(st);
    }
  }

  get noiseFloor(): number {
    return this._noiseFloor;
  }

  get lastSnr(): number {
    return this._lastSnr;
  }

  get framesDecoded(): number {
    return this._framesDecoded;
  }

  get syncFails(): number {
    return this._syncFails;
  }

  push(samples: Float64Array): ModemFrame[] {
    if (samples.length === 0) return [];
    this.buf = joinFloat(this.buf.subarray(this.pos), samples);
    this.pos = 0;
    const frames: ModemFrame[] = [];
    if (this.buf.length < CHIRP_LEN + 2000) return frames;
    const block = this.chirpCorr.blockSize;
    for (;;) {
      if (this.buf.length - this.pos < CHIRP_LEN + 2000) break;
      const chirpAt = this.findChirp(this.pos);
      if (chirpAt < 0) {
        this.skipLags.length = 0;
        this.pos += block - CHIRP_LEN;
        continue;
      }
      const attempt = this.tryFrame(chirpAt);
      if (attempt === "more") break;
      if (!attempt) {
        // The chirp band overlaps the data carriers, so the strongest
        // correlation peak can be a data-induced false alarm. Skip that lag
        // and re-scan the same window (the real chirp peak is usually weaker
        // and earlier). Give up after 4 candidates.
        this._syncFails++;
        this.skipLags.push(chirpAt - this.pos);
        if (this.skipLags.length >= 4) {
          this.skipLags.length = 0;
          this.pos += block - CHIRP_LEN;
        }
        continue;
      }
      this.skipLags.length = 0;
      frames.push(attempt.frame);
      this._framesDecoded++;
      this.pos = attempt.consumed;
    }
    this.buf = this.buf.subarray(this.pos);
    this.pos = 0;
    return frames;
  }

  private findChirp(start: number): number {
    const avail = Math.min(this.chirpCorr.blockSize, this.buf.length - start);
    if (avail < CHIRP_LEN + 500) return -1;
    const arr = new Float64Array(avail);
    for (let i = 0; i < avail; i++) arr[i] = this.buf[start + i];
    this._noiseFloor = rmsOf(arr, 0, Math.min(2048, avail));
    const corr = this.chirpCorr.correlate(arr, avail);
    let best = 0;
    let bestV = 0;
    let meanAbs = 0;
    for (let i = 0; i < corr.length; i++) {
      const v = Math.abs(corr[i]);
      meanAbs += v;
      let masked = false;
      for (const lag of this.skipLags) {
        if (Math.abs(i - lag) < CHIRP_LEN / 3) {
          masked = true;
          break;
        }
      }
      if (!masked && v > bestV) {
        bestV = v;
        best = i;
      }
    }
    meanAbs /= corr.length || 1;
    const ratio = bestV / (meanAbs + 1e-9);
    this._lastSnr = ratio;
    if (ratio > 8) return start + best;
    return -1;
  }

private tryFrame(chirpAt: number): { frame: ModemFrame; consumed: number } | null | "more" {
    const symLen = this.p.symbolLen;
    const syncStart = chirpAt + CHIRP_LEN;
    const bitsPerSymbol = this.p.carriers.length * 2;
    const payloadSyms = Math.ceil((8 * (this.p.payloadBytes + 3) * RATE) / bitsPerSymbol) + 1;
    if (syncStart + BARKER.length * symLen + payloadSyms * symLen > this.buf.length) return "more";

    const searchHalf = Math.floor(symLen / 3);
    let bestOff = 0;
    // Coherent barker matched filter: per-window phasors signed by the code
    // add in phase at any true symbol alignment (rotation-invariant for the
    // differential payload), scatter at mixture offsets.
    let bestCoh = -1;
    for (let off = -searchHalf; off <= searchHalf; off += 3) {
      const c = this.barkerCoherence(syncStart + off);
      if (c > bestCoh) {
        bestCoh = c;
        bestOff = off;
      }
    }
    for (let off = bestOff - 4; off <= bestOff + 4; off++) {
      const c = this.barkerCoherence(syncStart + off);
      if (c > bestCoh) {
        bestCoh = c;
        bestOff = off;
      }
    }
    const { yes } = this.barkerChecked(syncStart + bestOff);
    if (!yes) return null;
    // DQPSK phase reference re-anchors on every frame's reference symbol.
    this.refPhase.fill(Math.PI / 4);
    const payloadStart = syncStart + bestOff + BARKER.length * symLen;
    if (payloadStart + payloadSyms * symLen > this.buf.length) return null;

    // DQPSK demod, sample-exact (no symbol-grid snapping — the chirp peak
    // can land anywhere within a symbol period).
    const bits = new Uint8Array((payloadSyms - 1) * bitsPerSymbol);
    let bit = 0;
    for (let s = 0; s < payloadSyms; s++) {
      for (const [c, fc] of this.p.carriers.entries()) {
        void fc;
        const { re, im } = this.project(this.buf, payloadStart + s * symLen, c);
        const ph = Math.atan2(re, im);
        const delta = normAngle(ph - this.refPhase[c]);
        this.refPhase[c] = ph;
        if (s === 0) continue;
        const [b0, b1] = phaseToBits(delta);
        bits[bit++] = b0;
        bits[bit++] = b1;
      }
    }
    const decoded = this.decodeRates(bits);
    if (!decoded) return null;
    const consumed = payloadStart + payloadSyms * symLen;
    return { frame: decoded, consumed };
  }

  private project(samples: Float64Array, start: number, c: number): { re: number; im: number } {
    const symLen = this.p.symbolLen;
    const ct = this.cosT[c];
    const st = this.sinT[c];
    let re = 0;
    let imV = 0;
    for (let i = 0; i < symLen; i++) {
      const s = samples[start + i];
      if (s === undefined) break;
      re += s * ct[i];
      imV += s * st[i];
    }
    return { re, im: imV };
  }

  private barkerCoherence(syncStart: number): number {
    const { yes, coherence } = this.barkerChecked(syncStart);
    void yes;
    return coherence;
  }

  /** Complex barker alignment: signed phasor sum (rotation-invariant) plus
   *  coherence-vs-magnitude check (13 = perfect, ~3.6 = random scatter). */
  private barkerChecked(syncStart: number): { yes: boolean; coherence: number; magnitude: number } {
    const symLen = this.p.symbolLen;
    let re = 0;
    let im = 0;
    let mag = 0;
    for (let s = 0; s < BARKER.length; s++) {
      const p = this.project(this.buf, syncStart + s * symLen, SYNC_CARRIER);
      const r = BARKER[s] * p.re;
      const i = BARKER[s] * p.im;
      re += r;
      im += i;
      mag += Math.hypot(p.re, p.im);
    }
    const coherence = Math.hypot(re, im) / (mag / BARKER.length);
    return { yes: coherence >= 8, coherence, magnitude: mag / BARKER.length };
  }

  private decodeRates(bits: Uint8Array): ModemFrame | null {
    const N = bits.length;
    for (const rate of [3] as const) {
      if (N % rate !== 0) continue;
      const nSrc = Math.floor(N / rate);
      if (nSrc < (this.p.payloadBytes + 3) * 8) continue;
      // invert permutation
      let K = -1;
      for (let tryK = Math.floor(N / 2) + 1; tryK < N; tryK++) {
        if (gcd(N, tryK) === 1) {
          K = tryK;
          break;
        }
      }
      if (K < 0) continue;
      const Kinv = mulInvModulo(K, N);
      const fec = new Uint8Array(N);
      for (let t = 0; t < N; t++) fec[(t * Kinv) % N] = bits[t];
      // majority vote
      const bytes = new Uint8Array(nSrc >> 3);
      for (let c = 0; c < nSrc; c++) {
        let ones = 0;
        for (let r = 0; r < rate; r++) ones += fec[rate * c + r];
        if (ones * 2 >= rate) bytes[c >> 3] |= 1 << (7 - (c & 7));
      }
      const payloadBytes = this.p.payloadBytes;
      if (bytes.length < payloadBytes + 3) continue;
      const flagByte = bytes[0];
      const body = bytes.subarray(0, payloadBytes + 1);
      const crcGot = new DataView(bytes.buffer, bytes.byteOffset + payloadBytes + 1, 2).getUint16(0, false);
      if (crc16(body) !== crcGot) continue;
      return { rate: (flagByte & 3) as 1 | 2 | 3 || RATE, payload: bytes.slice(1, 1 + payloadBytes) };
    }
    return null;
  }
}

function joinFloat(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Seedable PRNG (mulberry32) for reproducible channel simulation. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simulate a dirty acoustic channel for tests and the noise meter. */
export function simulateChannel(
  signal: Float64Array,
  snrDb = 24,
  gain = 1,
  seed = 42,
): Float64Array {
  const rnd = prng(seed);
  const rms = rmsOf(signal, 0, signal.length) || 1;
  const noiseAmp = rms / Math.pow(10, snrDb / 20);
  const out = new Float64Array(signal.length);
  let ambient = 0;
  for (let i = 0; i < signal.length; i++) {
    // gaussian-ish noise (sum of uniforms), plus slow ambient hum
    const g = (rnd() + rnd() + rnd() - 1.5) * noiseAmp;
    ambient = ambient * 0.999 + (rnd() - 0.5) * noiseAmp * 0.02;
    out[i] = signal[i] * gain + g + ambient * 20;
  }
  return out;
}