import type { ProgressStats, TransferPhase } from "./types.ts";
import { fmtDuration } from "./util.ts";

interface Bucket {
  at: number;
  bytes: number;
}

export class TransferStats {
  private start = performance.now();
  private buckets: Bucket[] = [];
  private _transferredBytes = 0;
  private _chunksDelivered = 0;
  private _totalBytes = 0;
  private _totalChunks = 0;
  private _errors = 0;
  private _retries = 0;
  phase: TransferPhase = "connecting";

  constructor(totalBytes: number, totalChunks: number) {
    this._totalBytes = totalBytes;
    this._totalChunks = totalChunks;
  }

  setTotal(totalBytes: number, totalChunks: number) {
    this._totalBytes = totalBytes;
    this._totalChunks = totalChunks;
  }

  addBytes(n: number) {
    this._transferredBytes += n;
    this.buckets.push({ at: performance.now(), bytes: n });
    const cutoff = performance.now() - 2000;
    while (this.buckets.length && this.buckets[0].at < cutoff) this.buckets.shift();
  }

  chunkDelivered() {
    this._chunksDelivered++;
  }

  error() {
    this._errors++;
  }

  retry() {
    this._retries++;
  }

  private rateBps(): number {
    if (this.buckets.length < 2) {
      const dt = (performance.now() - this.start) / 1000;
      return dt > 0 ? this._transferredBytes / dt : 0;
    }
    const first = this.buckets[0];
    const last = this.buckets[this.buckets.length - 1];
    const span = (last.at - first.at) / 1000;
    if (span <= 0) return 0;
    const bytes = this.buckets.reduce((s, b) => s + b.bytes, 0);
    return bytes / span;
  }

  snapshot(): ProgressStats {
    const elapsedMs = performance.now() - this.start;
    const rate = this.rateBps();
    const remaining = Math.max(0, this._totalBytes - this._transferredBytes);
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : null;
    return {
      transferredBytes: this._transferredBytes,
      totalBytes: this._totalBytes,
      chunksDelivered: this._chunksDelivered,
      totalChunks: this._totalChunks,
      errors: this._errors,
      retries: this._retries,
      elapsedMs,
      etaMs: this._totalChunks === 0 ? 0 : etaMs,
      kbps: (rate * 8) / 1000,
      phase: this.phase,
    };
  }

  etaLabel(): string {
    const s = this.snapshot();
    if (s.etaMs === null) return "estimating…";
    return fmtDuration(s.etaMs);
  }
}