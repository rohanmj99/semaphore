import type { ChannelKind, ManifestHeader, ProgressStats, TransferPhase } from "./types.ts";
import {
  decryptChunk,
  encodeHeaderWire,
  ManifestBuilder,
  parseHeaderWire,
  reassemble,
  verifyWholeFile,
  type SliceSource,
} from "./chunker.ts";
import { encodeMessage, FrameParser, parseMessage, type WireMessage } from "./frames.ts";
import { HaveBitmap } from "./have-bitmap.ts";
import { TransferStats } from "./stats.ts";
import type { TransportEndpoint } from "./transports.ts";
import { fromBase64Url, toBase64Url } from "./util.ts";

export type SessionEvent =
  | { type: "phase"; phase: TransferPhase }
  | { type: "stats"; stats: ProgressStats }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "done"; sessionId: string }
  | { type: "chunk"; index: number };

const WINDOW_CHUNKS = 16; // ~4 MB in flight at 256 KB chunks
const RESEND_TIMEOUT_MS = 4000;
const MAX_TRIES = 6;

function bytesOf(m: WireMessage, field: "p" | "h" = "p"): Uint8Array {
  return fromBase64Url(m[field] as string);
}

/** Strips the wire length prefix and dispatches JSON messages. */
class MessageSink {
  private parser = new FrameParser();
  private unsub: (() => void) | null = null;

  constructor(
    private readonly endpoint: TransportEndpoint,
    private readonly onMessage: (m: WireMessage) => void,
  ) {}

  attach(): this {
    this.unsub = this.endpoint.onMessage((frame) => {
      for (const f of this.parser.push(frame)) {
        try {
          this.onMessage(parseMessage(f));
        } catch {
          /* non-JSON frame ignored */
        }
      }
    });
    return this;
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
  }
}

function chunkFrame(index: number, crc: number, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + ciphertext.length);
  new DataView(out.buffer).setUint32(0, index, false);
  new DataView(out.buffer).setUint32(4, crc, false);
  out.set(ciphertext, 8);
  return out;
}

export class ReceiverEngine {
  readonly sessionId: string;
  readonly sessionKey: Uint8Array;
  readonly stats: TransferStats;
  readonly have: HaveBitmap;
  header: ManifestHeader | null = null;
  private chunks = new Map<number, Uint8Array>();

  constructor(sessionId: string, sessionKey: Uint8Array) {
    this.sessionId = sessionId;
    this.sessionKey = sessionKey;
    this.stats = new TransferStats(0, 0);
    this.have = new HaveBitmap(0);
  }

  acceptHeader(wire: Uint8Array): "ok" | "wrongKey" | "invalid" {
    const res = parseHeaderWire(wire, this.sessionKey, this.sessionId);
    if (!res.ok) return res.reason === "wrongKey" ? "wrongKey" : "invalid";
    this.header = res.header;
    this.stats.setTotal(res.header.originalSize, res.header.totalChunks);
    this.stats.phase = "running";
    this.have.rebuild(res.header.totalChunks);
    return "ok";
  }

  /** @returns "ok" | "dup" | "bad" | "noHeader" */
  acceptChunkBytes(index: number, crc: number, ciphertext: Uint8Array): "ok" | "dup" | "bad" | "noHeader" {
    if (!this.header || index >= this.header.totalChunks) return "noHeader";
    if (this.have.has(index)) {
      this.stats.retry();
      return "dup";
    }
    const plain = decryptChunk(this.sessionKey, this.sessionId, index, ciphertext, crc);
    if (plain === null) {
      this.stats.error();
      return "bad";
    }
    this.chunks.set(index, plain);
    this.have.set(index);
    this.stats.addBytes(plain.length);
    this.stats.chunkDelivered();
    return "ok";
  }

  acceptChunkFrame(payload: Uint8Array): "ok" | "dup" | "bad" | "noHeader" {
    if (payload.length < 8) return "bad";
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return this.acceptChunkBytes(dv.getUint32(0, false), dv.getUint32(4, false), payload.slice(8));
  }

  get allReceived(): boolean {
    return this.header !== null && this.have.missingCount() === 0;
  }

  async finish(): Promise<{ ok: true; data: Uint8Array; header: ManifestHeader } | { ok: false; message: string }> {
    if (!this.header) return { ok: false, message: "no manifest received" };
    try {
      this.stats.phase = "verifying";
      const data = await reassemble(this.chunks, this.header);
      if (!verifyWholeFile(data, this.header)) {
        return { ok: false, message: "file checksum mismatch" };
      }
      this.stats.phase = "done";
      return { ok: true, data, header: this.header };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "reassembly failed" };
    }
  }

  /** Chunk plaintexts collected so far (should be used only after finish()). */
  mapOfChunks(): ReadonlyMap<number, Uint8Array> {
    return this.chunks;
  }
}

interface SenderOpts {
  onEvent?: (e: SessionEvent) => void;
  onHeader?: (header: ManifestHeader) => void;
  chunkSize?: number;
}

export class StreamSender {
  readonly sessionId: string;
  readonly stats: TransferStats;
  private readonly builder: ManifestBuilder;
  private readonly sessionKey: Uint8Array;
  private readonly opts: SenderOpts;
  private have: HaveBitmap;
  private inflight = new Map<number, { sentAt: number; tries: number }>();
  private state: "idle" | "sending" | "done" | "failed" = "idle";
  private timer: ReturnType<typeof setInterval> | null = null;
  private remote: TransportEndpoint | null = null;
  private cancelled = false;

  constructor(
    sessionId: string,
    sessionKey: Uint8Array,
    source: SliceSource,
    opts: SenderOpts = {},
  ) {
    this.sessionId = sessionId;
    this.sessionKey = sessionKey;
    this.builder = new ManifestBuilder(source, sessionId, sessionKey, opts.chunkSize);
    this.opts = opts;
    this.have = new HaveBitmap(this.builder.meta.totalChunks);
    this.stats = new TransferStats(this.builder.meta.originalSize, this.builder.meta.totalChunks);
  }

  private emit(e: SessionEvent) {
    this.opts.onEvent?.(e);
  }

  run(remote: TransportEndpoint): void {
    this.remote = remote;
    const sink = new MessageSink(remote, (m) => this.handleMessage(m)).attach();
    void (async () => {
      try {
        this.state = "sending";
        this.emit({ type: "phase", phase: "connecting" });
        const header = await this.builder.buildHeader();
        header.sessionId = this.sessionId;
        this.opts.onHeader?.(header);
        remote.send(encodeMessage({ t: "hello", sid: this.sessionId, h: toBase64Url(encodeHeaderWire(header, this.sessionKey)) }));
        this.timer = setInterval(() => this.resendExpired(), 250);
        await this.pump();
        if (this.state === "sending") this.done();
      } catch (e) {
        this.fail(e instanceof Error ? e.message : "send failed");
      } finally {
        sink.detach();
        if (this.timer) clearInterval(this.timer);
      }
    })();
  }

  private async pump() {
    const total = this.builder.meta.totalChunks;
    let next = 0;
    while (this.state === "sending" && this.have.missingCount() > 0) {
      while (this.inflight.size < WINDOW_CHUNKS && next < total) {
        if (this.have.has(next)) {
          next++;
          continue;
        }
        const index = next++;
        await this.sendChunk(index);
      }
      await sleep(25);
    }
  }

  private async sendChunk(index: number, tries = 1): Promise<void> {
    try {
      const { ciphertext, crc32 } = await this.builder.prepareChunk(index);
      if (this.state !== "sending" || !this.remote) return;
      this.inflight.set(index, { sentAt: performance.now(), tries });
      this.remote.send(
        encodeMessage({ t: "chunk", sid: this.sessionId, p: toBase64Url(chunkFrame(index, crc32, ciphertext)) }),
      );
      this.emit({ type: "chunk", index });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : "chunk prepare failed");
    }
  }

  private resendExpired() {
    if (this.state !== "sending" || !this.remote) return;
    const now = performance.now();
    for (const [index, meta] of [...this.inflight]) {
      if (now - meta.sentAt > RESEND_TIMEOUT_MS) {
        if (meta.tries >= MAX_TRIES) {
          this.fail("peer stopped responding");
          return;
        }
        this.stats.retry();
        void this.sendChunk(index, meta.tries + 1);
      }
    }
  }

  private handleMessage(m: WireMessage) {
    if (m.sid !== this.sessionId) return;
    if (m.t === "have" || m.t === "nack") {
      try {
        const parsed = HaveBitmap.fromBytes(bytesOf(m));
        // ignore malformed/pre-manifest bitmaps that contradict our manifest
        if (parsed.totalChunks !== this.builder.meta.totalChunks) return;
        this.have = parsed;
        for (const [index] of [...this.inflight]) {
          if (this.have.has(index)) this.inflight.delete(index);
        }
        this.stats.chunkDelivered();
      } catch {
        /* ignore malformed bitmap */
      }
    } else if (m.t === "done") {
      this.done();
    }
  }

  private done() {
    if (this.state !== "sending" || this.cancelled) return;
    this.state = "done";
    if (this.timer) clearInterval(this.timer);
    this.stats.phase = "done";
    this.emit({ type: "phase", phase: "done" });
    this.emit({ type: "stats", stats: this.stats.snapshot() });
    this.emit({ type: "done", sessionId: this.sessionId });
  }

  private fail(message: string) {
    if (this.state === "failed" || this.state === "done") return;
    this.state = "failed";
    if (this.timer) clearInterval(this.timer);
    this.stats.phase = "aborted";
    this.emit({ type: "error", message, fatal: true });
  }

  cancel() {
    this.cancelled = true;
    if (this.state === "sending") this.state = "idle";
    if (this.timer) clearInterval(this.timer);
  }
}

export class StreamReceiver {
  readonly engine: ReceiverEngine;
  private completed = false;
  private onDone: ((r: { ok: true; data: Uint8Array; header: ManifestHeader } | { ok: false; message: string }) => void) | null = null;

  constructor(
    sessionId: string,
    sessionKey: Uint8Array,
    private readonly onEvent?: (e: SessionEvent) => void,
  ) {
    this.engine = new ReceiverEngine(sessionId, sessionKey);
  }

  start(remote: TransportEndpoint) {
    new MessageSink(remote, (m) => {
      if (m.sid !== this.engine.sessionId) return;
      if (m.t === "hello") {
        const res = this.engine.acceptHeader(bytesOf(m, "h"));
        if (res === "ok") {
          this.onEvent?.({ type: "phase", phase: "running" });
          remote.send(encodeMessage({ t: "have", sid: this.engine.sessionId, p: toBase64Url(this.engine.have.toBytes()) }));
          this.maybeComplete(remote);
        } else {
          this.onEvent?.({ type: "error", message: "session key mismatch", fatal: true });
        }
      } else if (m.t === "chunk") {
        const payload = bytesOf(m);
        const res = this.engine.acceptChunkFrame(payload);
        if (res === "ok") {
          this.onEvent?.({ type: "chunk", index: new DataView(payload.buffer, 0, 4).getUint32(0, false) });
          remote.send(encodeMessage({ t: "have", sid: this.engine.sessionId, p: toBase64Url(this.engine.have.toBytes()) }));
          this.maybeComplete(remote);
        }
      }
    }).attach();
  }

  private maybeComplete(remote: TransportEndpoint) {
    if (this.engine.allReceived && !this.completed) {
      this.completed = true;
      this.onEvent?.({ type: "phase", phase: "verifying" });
      remote.send(encodeMessage({ t: "done", sid: this.engine.sessionId }));
      void this.engine.finish().then((r) => this.onDone?.(r));
    }
  }

  onComplete(cb: (r: { ok: true; data: Uint8Array; header: ManifestHeader } | { ok: false; message: string }) => void) {
    this.onDone = cb;
  }

  get stats() {
    return this.engine.stats;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { ChannelKind, ManifestHeader, TransferPhase };
export { encodeHeaderWire };