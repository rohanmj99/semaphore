import { describe, expect, it } from "vitest";
import {
  FOUNTAIN_MAX_PAYLOAD,
  fountainSymbol,
  LightTransport,
  parseFountainSymbol,
} from "./light.ts";
import {
  FOUNTAIN_SYMBOL_CIPHER,
  FountainDecoder,
  FountainEncoder,
  FountainReceiver,
  FountainSender,
  type SymbolEndpoint,
} from "./fountain.ts";
import { arraySource } from "../chunker.ts";
import { paintQr, renderQr } from "./light.ts";

function randomBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

/** Deterministic bridge between a sender and receiver light endpoint, with an
 *  optional symbol-loss rate and a drop-countdown to simulate a receiver that
 *  starts listening mid-transfer. */
class FakeLight implements SymbolEndpoint {
  readonly kind = "light" as const;
  readonly id = "fake";
  private msgHandlers = new Set<(f: Uint8Array) => void>();
  private symHandlers = new Set<(s: { k: number; id: number; data: Uint8Array }) => void>();
  private peer: FakeLight | null = null;
  private drop = 0;
  private dropCount = 0;
  private seen = 0;
  private rng = 1234567;

  connect(peer: FakeLight, drop = 0, dropCount = 0) {
    this.peer = peer;
    peer.peer = this;
    this.drop = drop;
    this.dropCount = dropCount;
  }

  private shouldDropSymbol(): boolean {
    if (this.dropCount > 0 && this.seen++ < this.dropCount) return true;
    this.rng = (Math.imul(this.rng, 1103515245) + 12345) >>> 0;
    return (this.rng >>> 16) / 0xffff < this.drop;
  }

  send(frame: Uint8Array): void {
    this.peer?.deliverFrame(frame);
  }

  sendSymbol(payload: Uint8Array): void {
    if (this.shouldDropSymbol()) return;
    this.peer?.deliverSymbol(payload);
  }

  onMessage(cb: (f: Uint8Array) => void): () => void {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }

  onSymbol(cb: (s: { k: number; id: number; data: Uint8Array }) => void): () => void {
    this.symHandlers.add(cb);
    return () => this.symHandlers.delete(cb);
  }

  onClose(cb: () => void): () => void {
    void cb;
    return () => {};
  }

  close(): void {}

  idle(): Promise<void> {
    return Promise.resolve();
  }

  private deliverFrame(frame: Uint8Array) {
    for (const cb of [...this.msgHandlers]) cb(frame);
  }

  private deliverSymbol(payload: Uint8Array) {
    const sym = parseFountainSymbol(payload);
    if (sym) for (const cb of [...this.symHandlers]) cb(sym);
  }
}

describe("fountain wire format", () => {
  it("round-trips a symbol and verifies its CRC16", () => {
    const data = randomBytes(1040, 7);
    const wire = fountainSymbol(128, 42, data);
    const parsed = parseFountainSymbol(wire);
    expect(parsed).toEqual({ k: 128, id: 42, data });
  });

  it("rejects corrupt payloads via the checksum", () => {
    const data = randomBytes(300, 9);
    const wire = fountainSymbol(10, 3, data);
    wire[wire.length - 1] ^= 0xff;
    expect(parseFountainSymbol(wire)).toBeNull();
  });

  it("rejects wrong magic and oversized payloads", () => {
    expect(parseFountainSymbol(new Uint8Array(4))).toBeNull();
    const tooBig = new Uint8Array(FOUNTAIN_MAX_PAYLOAD + 1);
    expect(() => fountainSymbol(1, 0, tooBig)).toThrow();
  });

  it("fits a 1 KB sealed symbol inside one QR payload", () => {
    const wire = fountainSymbol(1024, 0, randomBytes(FOUNTAIN_SYMBOL_CIPHER, 5));
    expect(wire.length).toBeLessThanOrEqual(1400);
  });
});

describe("LT codec", () => {
  const cases: Array<[number, number, number]> = [
    [1, 0, 0],
    [10, 3, 0.3],
    [100, 11, 0.3],
    [1000, 88, 0.3],
  ];

  for (const [k, seed, drop] of cases) {
    it(`decodes k=${k} with ${Math.round(drop * 100)}% symbol loss`, () => {
      const source = Array.from({ length: k }, () => randomBytes(FOUNTAIN_SYMBOL_CIPHER, seed + k * 1000));
      const enc = new FountainEncoder(source, seed);
      const dec = new FountainDecoder(seed, k, FOUNTAIN_SYMBOL_CIPHER);
      const pool = Math.ceil(k * 1.2);
      // Two passes, dropping `drop` of symbols, in shuffled order.
      const order = Array.from({ length: pool * 2 }, (_, i) => i);
      let r = seed >>> 0;
      for (let i = order.length - 1; i > 0; i--) {
        r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
        const j = r % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      let received = 0;
      for (const id of order) {
        const s = seed + id * 7919;
        if (((s >>> 8) % 100) / 100 < drop) continue;
        dec.push(id, enc.symbol(id));
        received++;
      }
      expect(dec.solvedCount).toBe(k);
      expect(received).toBeGreaterThan(k);
      const got = dec.symbols() as Uint8Array[];
      expect(got).toEqual(source);
    });
  }

  it("dedupes repeated symbols", () => {
    const source = [randomBytes(FOUNTAIN_SYMBOL_CIPHER, 1)];
    const enc = new FountainEncoder(source, 99);
    const dec = new FountainDecoder(99, 1, FOUNTAIN_SYMBOL_CIPHER);
    expect(dec.push(0, enc.symbol(0))).toBe(true);
    expect(dec.push(0, enc.symbol(0))).toBe(false);
    expect(dec.solvedCount).toBe(1);
    expect(dec.symbols()).toEqual(source);
  });
});

describe("fountain session transfer", () => {
  it("transfers a file over a lossy light link", async () => {
    const original = randomBytes(300_000, 1234);
    const key = randomBytes(32, 9);
    const tx = new FakeLight();
    const rx = new FakeLight();
    tx.connect(rx, 0.3);

    const sender = new FountainSender("sess-1", key, arraySource(original, "big.bin"));
    const receiver = new FountainReceiver("sess-1", key);
    const result = await new Promise<{ ok: boolean; data?: Uint8Array; message?: string }>((resolve) => {
      receiver.onComplete((r) => resolve(r));
      receiver.start(rx);
      sender.run(tx);
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(original);
  });

  it("completes an empty file", async () => {
    const key = randomBytes(32, 4);
    const tx = new FakeLight();
    const rx = new FakeLight();
    tx.connect(rx, 0);
    const sender = new FountainSender("sess-2", key, arraySource(new Uint8Array(0), "empty.txt"));
    const receiver = new FountainReceiver("sess-2", key);
    const result = await new Promise<{ ok: boolean; data?: Uint8Array; message?: string }>((resolve) => {
      receiver.onComplete((r) => resolve(r));
      receiver.start(rx);
      sender.run(tx);
    });
    expect(result.ok).toBe(true);
    expect(result.data?.length).toBe(0);
  });

  it("recovers when a receiver starts listening mid-transfer", async () => {
    const original = randomBytes(200_000, 42);
    const key = randomBytes(32, 3);
    const tx = new FakeLight();
    const rx = new FakeLight();
    // The receiver misses the first pass and change of symbols (as if it
    // started scanning late); the sender's repeated params + self-contained
    // symbols let it catch the rest on the following passes.
    tx.connect(rx, 0, 300);
    const sender = new FountainSender("sess-3", key, arraySource(original, "late.bin"), {
      maxPasses: 4,
    });
    const receiver = new FountainReceiver("sess-3", key);
    const result = await new Promise<{ ok: boolean; data?: Uint8Array; message?: string }>((resolve) => {
      receiver.onComplete((r) => resolve(r));
      receiver.start(rx);
      sender.run(tx);
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(original);
  });
});

describe("light transport symbols + pacing", () => {
  it("buffers a fountain symbol as a single-fragment display", () => {
    const tx = new LightTransport({ tx: true, rx: false });
    const wire = fountainSymbol(4, 7, randomBytes(64, 2));
    tx.sendSymbol(wire);
    expect(tx.fragmentCount).toBe(1);
    expect(tx.currentFrag()).toEqual(wire);
    tx.close();
  });

  it("routes decoded fountain symbols to symbol handlers", () => {
    const rx = new LightTransport({ tx: false, rx: true });
    const wire = fountainSymbol(16, 3, randomBytes(300, 8));
    const got: Array<{ k: number; id: number }> = [];
    const unsub = rx.onSymbol((s) => got.push({ k: s.k, id: s.id }));
    const m = renderQr(wire);
    const img = paintQr(m, 6);
    rx.feedImage(img.rgba, img.width, img.height);
    expect(got).toEqual([{ k: 16, id: 3 }]);
    unsub();
    rx.close();
  });

  it("leaves fountain payloads out of fragment reassembly", () => {
    const rx = new LightTransport({ tx: false, rx: true });
    const delivered: Uint8Array[] = [];
    rx.onMessage((f) => delivered.push(f));
    const wire = fountainSymbol(4, 1, randomBytes(100, 6));
    const m = renderQr(wire);
    const img = paintQr(m, 6);
    rx.feedImage(img.rgba, img.width, img.height);
    expect(delivered).toEqual([]);
    rx.close();
  });

  it("paces idle() by frameMs", async () => {
    const tx = new LightTransport({ tx: true, rx: false, frameMs: 100 });
    expect(tx.frameMs).toBe(100);
    tx.frameMs = 50;
    const t0 = performance.now();
    await tx.idle();
    const dt = performance.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(45);
    tx.close();
  });
});