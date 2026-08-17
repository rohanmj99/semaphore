import { concatB, fromBase64Url, toBase64Url } from "../util.ts";
import type { TransportEndpoint } from "../transports.ts";
import type { ManifestHeader, ProgressStats, TransferPhase } from "../types.ts";
import { encodeMessage, FrameParser, parseMessage, type WireMessage } from "../frames.ts";
import {
  ManifestBuilder,
  encodeHeaderWire,
  parseHeaderWire,
  verifyWholeFile,
  type SliceSource,
} from "../chunker.ts";
import { chunkNonce, openSeal } from "../crypto.ts";
import { TransferStats } from "../stats.ts";
import { fountainSymbol, parseFountainSymbol } from "./light.ts";

/**
 * Fountain (Luby Transform) coding for the light channel.
 *
 * The sender splits the file into K source symbols, seals each with the
 * session key, and broadcasts encoded symbols — each encoded symbol is the
 * XOR of a deterministic, pseudo-randomly chosen subset of source symbols.
 * The receiver collects encoded symbols in any order (drops and duplicates
 * are fine), and a belief-propagation decoder recovers the K source symbols
 * once it has collected slightly more than K pieces (typically K + ~6%).
 * Because the seed and symbol count travel with the first message, a
 * receiver that starts scanning mid-transfer can still rebuild the file —
 * the encoded symbols are self-contained.
 *
 * All encoding is deterministic: the neighbor set of encoded symbol `id` is
 * drawn from a PRNG seeded by (seed, id), so the receiver regenerates the
 * same neighbors without any per-symbol metadata beyond the header.
 */

/** Source symbol size (plaintext) — one symbol ≈ one QR payload. */
export const FOUNTAIN_SYMBOL_BYTES = 1024;
/** Sealed symbol size = plaintext + AEAD tag. */
export const FOUNTAIN_SYMBOL_CIPHER = FOUNTAIN_SYMBOL_BYTES + 16;
/** Broadcast passes before the sender stops cycling (symbols are independent,
 *  so a persistent receiver needs just over one pass; a late joiner catches
 *  the rest on the next pass). Pass `maxPasses: 0` to keep cycling forever —
 *  the app's light channel does this so the flashes keep repeating until the
 *  user cancels, and the receiver picks up whatever it missed on the next
 *  pass. */
export const FOUNTAIN_PASSES = 2;
/** Encoded symbols per pass — K + overhead so one pass alone usually suffices. */
export const FOUNTAIN_OVERHEAD_RATIO = 1.2;
/** Symbols buffered by a receiver that hasn't seen the seed message yet. */
const FOUNTAIN_MAX_BUFFER = 8192;
/** Residual rows that trigger the GE fallback; larger residuals just keep
 *  collecting symbols until belief propagation finishes them. */
const MAX_GE_ROWS = 512;
/** Run the GE fallback at most once per this many newly received symbols. */
const GE_EVERY = 32;

/* ------------------------------------------------------------------ */
/* Deterministic PRNG + robust soliton distribution                    */

function hash32(seed: number, esi: number): number {
  let h = ((seed >>> 0) + Math.imul(esi >>> 0, 0x9e3779b1) + 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cumulative robust soliton degree distribution for K source symbols. */
function robustSolitonCdf(k: number, c = 0.1, delta = 0.05): Float64Array {
  const r = Math.min(k - 1, Math.max(1, Math.round(c * Math.log(k / delta) * Math.sqrt(k))));
  const spike = Math.max(1, Math.round(k / r));
  const cdf = new Float64Array(k + 1);
  let total = 0;
  for (let d = 1; d <= k; d++) {
    let p = d === 1 ? 1 / k : 1 / (d * (d - 1));
    if (d < spike) p += r / (d * k);
    else if (d === spike) p += (r / k) * Math.log(r / delta);
    total += p;
    cdf[d] = total;
  }
  for (let d = 1; d <= k; d++) cdf[d] /= total;
  return cdf;
}

function sampleDegree(cdf: Float64Array, u: number): number {
  let lo = 1;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** GF(2) symmetric difference of two sorted index lists. */
function xorCols(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (a[i] < b[j]) {
      out.push(a[i++]);
    } else {
      out.push(b[j++]);
    }
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Encoder / decoder                                                   */

/** Deterministic neighbor set of encoded symbol `id` for K source symbols. */
function neighborsOf(k: number, cdf: Float64Array, seed: number, id: number): number[] {
  const rng = mulberry32(hash32(seed, id));
  const deg = k === 1 ? 1 : Math.min(k, sampleDegree(cdf, rng()));
  const out: number[] = [];
  while (out.length < deg) {
    const idx = Math.floor(rng() * k);
    if (!out.includes(idx)) out.push(idx);
  }
  return out;
}

export class FountainEncoder {
  readonly k: number;
  readonly symbolSize: number;
  private readonly cdf: Float64Array;

  /**
   * @param symbols sealed source symbols, all exactly `symbolSize` bytes
   * @param seed shared deterministic seed (sent in the fountain params message)
   */
  constructor(
    private readonly symbols: Uint8Array[],
    readonly seed: number,
  ) {
    this.k = symbols.length;
    this.symbolSize = symbols[0]?.length ?? 0;
    this.cdf = this.k > 0 ? robustSolitonCdf(this.k) : new Float64Array(0);
  }

  neighbors(id: number): number[] {
    return neighborsOf(this.k, this.cdf, this.seed, id);
  }

  /** Encoded payload for symbol `id` — XOR of its neighbor source symbols. */
  symbol(id: number): Uint8Array {
    const out = new Uint8Array(this.symbolSize);
    for (const n of this.neighbors(id)) {
      const s = this.symbols[n];
      for (let i = 0; i < this.symbolSize; i++) out[i] ^= s[i];
    }
    return out;
  }
}

/**
 * Belief-propagation LT decoder. Feed encoded symbols in any order; call
 * `symbols()` when `solvedCount === k` to get the source symbols back.
 */
export class FountainDecoder {
  readonly k: number;
  readonly symbolSize: number;
  private readonly cdf: Float64Array;
  private received = new Map<number, { neighbors: number[]; payload: Uint8Array }>();
  private solved: (Uint8Array | null)[] = [];
  private geAt = 0;
  private done = false;

  constructor(
    readonly seed: number,
    k: number,
    symbolSize: number,
  ) {
    this.k = k;
    this.symbolSize = symbolSize;
    this.cdf = k > 0 ? robustSolitonCdf(k) : new Float64Array(0);
    this.solved = new Array(k).fill(null);
  }

  get solvedCount(): number {
    let n = 0;
    for (const s of this.solved) if (s) n++;
    return n;
  }

  get complete(): boolean {
    return this.done || this.solvedCount === this.k;
  }

  /** Feed one encoded symbol (transport-verified). False when duplicate/unknown. */
  push(id: number, payload: Uint8Array): boolean {
    if (this.done || payload.length !== this.symbolSize) return false;
    if (this.received.has(id)) return false;
    const neighbors = neighborsOf(this.k, this.cdf, this.seed, id);
    if (neighbors.length === 0) return false;
    // Peel off any source symbols already solved — their value was XORed in
    // before this symbol arrived, so remove it before reducing.
    const p = payload.slice();
    const fresh: number[] = [];
    for (const n of neighbors) {
      const v = this.solved[n];
      if (v) {
        for (let i = 0; i < p.length; i++) p[i] ^= v[i];
      } else {
        fresh.push(n);
      }
    }
    if (fresh.length === 0) return false;
    if (fresh.length === 1) {
      this.solve(fresh[0], p);
    } else {
      this.received.set(id, { neighbors: fresh, payload: p });
    }
    // Belief propagation can stall when the ripple empties — a bounded
    // Gaussian elimination over the residual finishes the decode. Gated so
    // it runs at most once per window of new symbols while stalled.
    this.maybeGaussian(false);
    return true;
  }

  /** Bounded GE fallback; `force` ignores the arrival window gate. */
  private maybeGaussian(force: boolean): void {
    if (this.done || this.received.size === 0 || this.received.size > MAX_GE_ROWS) return;
    if (!force && this.received.size < this.geAt + GE_EVERY) return;
    this.geAt = this.received.size;
    for (let iter = 0; iter < 8 && !this.done && this.received.size > 0; iter++) {
      if (!this.gaussianStep()) return;
    }
  }

  private gaussianStep(): boolean {
    // Row-echelon reduction over GF(2) of the reduced residual rows, then
    // back-substitute from the largest leading column downward. Every symbol
    // solved here cascades through solve(), so one successful step usually
    // collapses the whole residual.
    const pivots = new Map<number, { cols: number[]; payload: Uint8Array }>();
    for (const sym of this.received.values()) {
      if (sym.neighbors.length === 0) continue;
      let cols = sym.neighbors.slice().sort((a, b) => a - b);
      let payload = sym.payload.slice();
      while (cols.length > 0 && pivots.has(cols[0])) {
        const p = pivots.get(cols[0]) as { cols: number[]; payload: Uint8Array };
        payload = xorBytes(payload, p.payload);
        cols = xorCols(cols, p.cols);
      }
      if (cols.length === 0) continue;
      pivots.set(cols[0], { cols, payload });
    }
    const ordered = [...pivots.entries()].sort((a, b) => b[0] - a[0]);
    let solvedAny = false;
    for (const [, row] of ordered) {
      let value = row.payload.slice();
      const remaining: number[] = [];
      for (const c of row.cols) {
        const v = this.solved[c];
        if (v) {
          for (let i = 0; i < value.length; i++) value[i] ^= v[i];
        } else {
          remaining.push(c);
        }
      }
      if (remaining.length === 1) {
        this.solve(remaining[0], value);
        solvedAny = true;
      }
    }
    return solvedAny;
  }

  private solve(index: number, value: Uint8Array) {
    if (this.solved[index]) return;
    this.solved[index] = value;
    const queue = [index];
    while (queue.length) {
      const n = queue.shift() as number;
      const v = this.solved[n] as Uint8Array;
      for (const [esi, sym] of [...this.received]) {
        const at = sym.neighbors.indexOf(n);
        if (at < 0) continue;
        sym.neighbors.splice(at, 1);
        const p = sym.payload;
        for (let i = 0; i < p.length; i++) p[i] ^= v[i];
        if (sym.neighbors.length === 1) {
          const last = sym.neighbors[0];
          this.received.delete(esi);
          this.solve(last, p);
        } else if (sym.neighbors.length === 0) {
          this.received.delete(esi);
        }
      }
    }
  }

  /** Source symbols in index order, or null while still incomplete. */
  symbols(): Uint8Array[] | null {
    if (this.done) return this.solved as Uint8Array[];
    // One final elimination attempt — the received set may be sufficient
    // even though the last few arrivals never tripped the gate.
    this.maybeGaussian(true);
    for (const s of this.solved) if (!s) return null;
    this.done = true;
    return this.solved as Uint8Array[];
  }
}

/* ------------------------------------------------------------------ */
/* Session layer — broadcast sender / receiver                         */

export interface FountainParams {
  /** Total source symbols. */
  k: number;
  /** Deterministic PRNG seed for neighbor sets. */
  seed: number;
  /** Sealed symbol size in bytes. */
  sym: number;
}

/** Light transport surface used by the fountain session layer. */
export interface SymbolEndpoint extends TransportEndpoint {
  sendSymbol(payload: Uint8Array): void;
  onSymbol(cb: (sym: { k: number; id: number; data: Uint8Array }) => void): () => void;
}

export type SessionEvent =
  | { type: "phase"; phase: TransferPhase }
  | { type: "stats"; stats: ProgressStats }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "done"; sessionId: string };

interface FountainSenderOpts {
  onEvent?: (e: SessionEvent) => void;
  onHeader?: (header: ManifestHeader) => void;
  symbolSize?: number;
  seed?: number;
  /** Stop cycling after this many passes (0 = keep cycling). */
  maxPasses?: number;
}

function bytesOf(m: WireMessage, field: "h" | "p"): Uint8Array {
  return fromBase64Url(m[field] as string);
}

/** Strips framing and dispatches JSON wire messages (mirrors session.ts). */
function attachMessageSink(
  endpoint: TransportEndpoint,
  onMessage: (m: WireMessage) => void,
): () => void {
  const parser = new FrameParser();
  return endpoint.onMessage((frame) => {
    const parsed: WireMessage[] = [];
    try {
      parsed.push(parseMessage(frame));
    } catch {
      try {
        for (const f of parser.push(frame)) parsed.push(parseMessage(f));
      } catch {
        parser.reset();
      }
    }
    for (const m of parsed) {
      try {
        onMessage(m);
      } catch {
        /* consumer errors are isolated */
      }
    }
  });
}

export class FountainSender {
  readonly sessionId: string;
  readonly stats: TransferStats;
  private readonly builder: ManifestBuilder;
  private readonly sessionKey: Uint8Array;
  private readonly symbolSize: number;
  private readonly seed: number;
  private readonly opts: FountainSenderOpts;
  private encoder: FountainEncoder | null = null;
  private remote: TransportEndpoint | null = null;
  private state: "idle" | "sending" | "done" | "failed" = "idle";
  private cancelled = false;
  private passes = 0;

  constructor(
    sessionId: string,
    sessionKey: Uint8Array,
    source: SliceSource,
    opts: FountainSenderOpts = {},
  ) {
    this.sessionId = sessionId;
    this.sessionKey = sessionKey;
    this.symbolSize = opts.symbolSize ?? FOUNTAIN_SYMBOL_BYTES;
    this.seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
    this.opts = opts;
    this.builder = new ManifestBuilder(source, sessionId, sessionKey, this.symbolSize);
    this.stats = new TransferStats(this.builder.meta.originalSize, this.builder.meta.totalChunks);
  }

  private emit(e: SessionEvent) {
    this.opts.onEvent?.(e);
  }

  run(remote: TransportEndpoint): void {
    this.remote = remote;
    const tx = remote;
    void (async () => {
      try {
        this.state = "sending";
        this.emit({ type: "phase", phase: "connecting" });
        const header = await this.builder.buildHeader();
        header.sessionId = this.sessionId;
        this.opts.onHeader?.(header);
        const k = header.totalChunks;
        if (k === 0) {
          // Empty file — nothing to encode.
          tx.send(this.helloFrame(header));
          await this.waitIdle();
          tx.send(this.fountFrame(k));
          await this.waitIdle();
          this.done();
          return;
        }
        if (k > 0xffff) {
          this.fail("File too large for screen flash transfer.");
          return;
        }
        const symbols: Uint8Array[] = [];
        for (let i = 0; i < k; i++) {
          const { ciphertext } = await this.builder.prepareChunk(i);
          // Every sealed symbol must have the same length for XOR — pad the
          // (possibly short) last one to the full sealed size.
          const padded = new Uint8Array(this.symbolSize + 16);
          padded.set(ciphertext);
          symbols.push(padded);
        }
        this.encoder = new FountainEncoder(symbols, this.seed);
        await this.pump(k);
        if (this.state === "sending") this.done();
      } catch (e) {
        this.fail(e instanceof Error ? e.message : "send failed");
      }
    })();
  }

  private helloFrame(header: ManifestHeader): Uint8Array {
    return encodeMessage({ t: "hello", sid: this.sessionId, h: toBase64Url(encodeHeaderWire(header, this.sessionKey)) });
  }

  private fountFrame(k: number): Uint8Array {
    return encodeMessage({ t: "fount", sid: this.sessionId, k, seed: this.seed, sym: this.symbolSize + 16 });
  }

  /** Broadcast: re-send hello + params once per pass and every few symbols so
   *  receivers joining mid-transfer sync within a few frames, and cycle
   *  encoded symbols. Each send is paced by the transport's `idle()`. */
  private async pump(k: number): Promise<void> {
    const encoder = this.encoder as FountainEncoder;
    const maxPasses = this.opts.maxPasses ?? FOUNTAIN_PASSES;
    const pool = Math.max(k, Math.ceil(k * FOUNTAIN_OVERHEAD_RATIO));
    const helloEvery = 4;
    while (this.state === "sending") {
      if (this.remote) {
        this.stats.phase = this.passes === 0 || maxPasses === 0 ? "running" : "repair";
        this.emit({ type: "phase", phase: this.stats.phase });
        this.remote.send(this.helloFrame(this.builder.header));
        await this.waitIdle();
        this.remote.send(this.fountFrame(k));
        await this.waitIdle();
        for (let i = 0; i < pool; i++) {
          const id = this.passes * pool + i;
          const payload = encoder.symbol(id);
          (this.remote as unknown as SymbolEndpoint).sendSymbol(fountainSymbol(k, id, payload));
          await this.waitIdle();
          this.stats.addBytes(encoder.symbolSize);
          this.stats.chunkDelivered();
          if (i + 1 < pool && (i + 1) % helloEvery === 0) {
            this.remote.send(this.helloFrame(this.builder.header));
            await this.waitIdle();
            this.remote.send(this.fountFrame(k));
            await this.waitIdle();
          }
        }
      }
      this.passes++;
      this.stats.passes = this.passes;
      this.stats.phase = "repair";
      this.emit({ type: "stats", stats: this.stats.snapshot() });
      // Let macrotasks run between passes even when the transport paces
      // instantly (tests), so a maxPasses: 0 broadcast stays cooperative.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (maxPasses > 0 && this.passes >= maxPasses) return;
    }
  }

  private waitIdle(): Promise<void> {
    const remote = this.remote;
    if (!remote) return Promise.resolve();
    const idle = (remote as { idle?: () => Promise<void> }).idle;
    return idle ? idle.call(remote) : Promise.resolve();
  }

  private done() {
    if (this.state !== "sending" || this.cancelled) return;
    this.state = "done";
    this.stats.phase = "done";
    this.emit({ type: "phase", phase: "done" });
    this.emit({ type: "stats", stats: this.stats.snapshot() });
    this.emit({ type: "done", sessionId: this.sessionId });
  }

  private fail(message: string) {
    if (this.state === "failed" || this.state === "done") return;
    this.state = "failed";
    this.stats.phase = "aborted";
    this.emit({ type: "error", message, fatal: true });
  }

  cancel() {
    this.cancelled = true;
    if (this.state === "sending") this.state = "idle";
  }
}

export class FountainReceiver {
  readonly engine: {
    sessionId: string;
    sessionKey: Uint8Array;
    header: ManifestHeader | null;
    stats: TransferStats;
    allReceived: boolean;
  };
  private completed = false;
  private onDone: ((r: { ok: true; data: Uint8Array; header: ManifestHeader } | { ok: false; message: string }) => void) | null = null;
  private decoder: FountainDecoder | null = null;
  private params: FountainParams | null = null;
  private buffered = new Map<number, Uint8Array>();

  constructor(
    readonly sessionId: string,
    readonly sessionKey: Uint8Array,
    private readonly onEvent?: (e: SessionEvent) => void,
  ) {
    this.engine = {
      sessionId,
      sessionKey,
      header: null,
      stats: new TransferStats(0, 0),
      allReceived: false,
    };
  }

  start(remote: TransportEndpoint) {
    const symbolRemote = remote as unknown as SymbolEndpoint;
    symbolRemote.onSymbol((sym) => this.acceptSymbol(sym));
    attachMessageSink(remote, (m) => {
      if (m.sid !== this.sessionId) return;
      if (m.t === "hello") {
        if (this.engine.header !== null) return;
        const res = parseHeaderWire(bytesOf(m, "h"), this.sessionKey, this.sessionId);
        if (res.ok) {
          this.engine.header = res.header;
          this.engine.stats.setTotal(res.header.originalSize, res.header.totalChunks);
          this.engine.stats.phase = "running";
          this.onEvent?.({ type: "phase", phase: "running" });
        } else if (res.reason === "wrongKey") {
          this.onEvent?.({ type: "error", message: "session key mismatch", fatal: true });
        }
      } else if (m.t === "fount") {
        const k = Number(m.k);
        const seed = Number(m.seed);
        const sym = Number(m.sym);
        if (!Number.isInteger(k) || k < 0 || k > 0xffff || !Number.isInteger(seed) || !Number.isInteger(sym)) {
          return;
        }
        this.setupFountain({ k, seed, sym });
      }
    });
  }

  private setupFountain(params: FountainParams) {
    if (this.decoder || this.completed) return;
    this.params = params;
    if (params.k === 0) {
      // Empty file — nothing to decode; the whole-file checksum is trivial.
      this.decoder = new FountainDecoder(params.seed, 0, 0);
      void this.finish();
      return;
    }
    if (params.sym < 1 || params.sym > FOUNTAIN_SYMBOL_CIPHER) return;
    this.decoder = new FountainDecoder(params.seed, params.k, params.sym);
    for (const [id, data] of this.buffered) {
      this.decoder.push(id, data);
    }
    this.buffered.clear();
    this.maybeComplete();
  }

  private acceptSymbol(sym: { k: number; id: number; data: Uint8Array }) {
    if (this.completed) return;
    if (!this.decoder) {
      // Params (seed/count) not seen yet — buffer a bounded window so a
      // receiver joining mid-transfer doesn't waste the symbols it caught.
      if (this.buffered.size >= FOUNTAIN_MAX_BUFFER) this.buffered.clear();
      this.buffered.set(sym.id, sym.data);
      return;
    }
    if (sym.k !== this.decoder.k) return;
    if (this.decoder.push(sym.id, sym.data)) {
      this.engine.allReceived = this.decoder.complete;
      this.maybeComplete();
    }
  }

  private maybeComplete() {
    if (this.completed || !this.decoder) return;
    if (this.decoder.k > 0 && this.decoder.solvedCount === this.decoder.k) {
      void this.finish();
    }
  }

  private async finish() {
    if (this.completed) return;
    this.completed = true;
    const header = this.engine.header;
    if (!header || !this.decoder || !this.params) {
      this.onDone?.({ ok: false, message: "no manifest received" });
      return;
    }
    const symbols = this.decoder.symbols();
    if (!symbols) {
      this.onDone?.({ ok: false, message: "couldn't decode the file" });
      return;
    }
    this.engine.stats.phase = "verifying";
    this.onEvent?.({ type: "phase", phase: "verifying" });
    const symSize = this.params.sym;
    // The sender padded the last (short) plaintext symbol to a uniform size
    // before sealing — trim the ciphertext back to its real length first.
    const lastLen = header.originalSize - (header.totalChunks - 1) * (symSize - 16);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < symbols.length; i++) {
      const ct =
        i === symbols.length - 1 ? symbols[i].slice(0, Math.max(0, lastLen) + 16) : symbols[i];
      const plain = openSeal(this.sessionKey, chunkNonce(this.sessionKey, this.sessionId, i), ct);
      if (plain === null) {
        this.onDone?.({ ok: false, message: "symbol decrypt failed" });
        return;
      }
      parts.push(plain);
    }
    const data = concatB(parts);
    if (!verifyWholeFile(data, header)) {
      this.onDone?.({ ok: false, message: "file checksum mismatch" });
      return;
    }
    this.engine.stats.addBytes(data.length);
    for (let i = 0; i < header.totalChunks; i++) this.engine.stats.chunkDelivered();
    this.engine.stats.phase = "done";
    this.onEvent?.({ type: "phase", phase: "done" });
    this.onDone?.({ ok: true, data, header });
  }

  onComplete(cb: (r: { ok: true; data: Uint8Array; header: ManifestHeader } | { ok: false; message: string }) => void) {
    this.onDone = cb;
  }

  get stats() {
    return this.engine.stats;
  }
}

/* Re-export for the session-facing callers. */
export { parseFountainSymbol, fountainSymbol };