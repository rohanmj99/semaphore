import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto, keypair, deriveKxSessionKey } from "./crypto.ts";
import { arraySource } from "./chunker.ts";
import { StreamReceiver, StreamSender } from "./session.ts";
import { loopbackPair } from "./transports.ts";
import { ReceiverEngine } from "./session.ts";
import { parseMessage, FrameParser } from "./frames.ts";
import { fromBase64Url } from "./util.ts";
import type { TransportEndpoint } from "./transports.ts";
import type { ProgressStats } from "./types.ts";

type SessionOutcome = Parameters<Parameters<StreamReceiver["onComplete"]>[0]>[0];

/** Simulates a paced broadcast transport (sound/light): each send is
 *  delivered, and idle() blocks until the previous send has drained. */
class RecordTransport implements TransportEndpoint {
  readonly kind = "light" as const;
  readonly id = "record";
  frames: Uint8Array[] = [];
  private handlers = new Set<(frame: Uint8Array) => void>();
  private pending = 0;
  private drainWaiters: Array<() => void> = [];

  send(frame: Uint8Array): void {
    this.frames.push(frame);
    this.pending++;
    for (const h of [...this.handlers]) h(frame);
    queueMicrotask(() => {
      this.pending = 0;
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const w of waiters) w();
    });
  }

  async idle(): Promise<void> {
    if (this.pending === 0) return;
    await new Promise<void>((r) => this.drainWaiters.push(r));
  }

  onMessage(cb: (frame: Uint8Array) => void): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }

  onClose(): () => void {
    return () => {};
  }

  close(): void {}
}

describe("stream session over loopback transport", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  const runTransfer = async (size: number, chunkSize: number) => {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 73 + (i >> 4)) & 0xff;
    const kp = keypair();
    const sessionId = `loop-${Math.random().toString(36).slice(2, 8)}`;
    const sessionKey = deriveKxSessionKey(sessionId, kp.publicKey, kp.secretKey);
    const { a, b } = loopbackPair();

    const receiver = new StreamReceiver(sessionId, sessionKey.key);
    let resolveSender: (() => void) | null = null;
    const completed = new Promise<SessionOutcome>((res) => {
      receiver.onComplete((r) => res(r));
    });
    const senderDone = new Promise<void>((res) => {
      resolveSender = res;
    });
    receiver.start(a);

    const sender = new StreamSender(sessionId, sessionKey.key, arraySource(data, "loop.bin"), {
      chunkSize,
      onEvent: (e) => {
        if (e.type === "done") resolveSender?.();
      },
    });
    sender.run(b);
    await Promise.all([completed, senderDone]);
    const outcome = await completed;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data).toEqual(data);
    }
    return { receiver, data };
  };

  it("transfers 10 KB intact", async () => {
    await runTransfer(10 * 1024, 256 * 1024);
  });

  it("transfers 100 KB in small chunks with retries allowed", async () => {
    await runTransfer(100 * 1024, 1024);
  });

  it("handles multiple chunks > window size", async () => {
    await runTransfer(64 * 1024 + 13, 4096);
  });

  it("receiver rejects mismatched sessions", async () => {
    const kp = keypair();
    const kp2 = keypair();
    const engine = new ReceiverEngine("sess-a", deriveKxSessionKey("sess-a", kp.publicKey, kp.secretKey).key);
    const { ManifestBuilder, encodeHeaderWire } = await import("./chunker.ts");
    const otherKey = deriveKxSessionKey("sess-b", kp2.publicKey, kp2.secretKey).key;
    const builder0 = new ManifestBuilder(arraySource(new Uint8Array(8), "x.bin"), "sess-b", otherKey, 8);
    const header = await builder0.buildHeader();
    const wire = encodeHeaderWire(header, otherKey);
    expect(engine.acceptHeader(wire)).toBe("wrongKey");
  });

  it("transfers empty (0-byte) file", async () => {
    const data = new Uint8Array(0);
    const kp = keypair();
    const sessionId = "empty-session";
    const sessionKey = deriveKxSessionKey(sessionId, kp.publicKey, kp.secretKey);
    const { a, b } = loopbackPair();
    const receiver = new StreamReceiver(sessionId, sessionKey.key);
    let done: "ok" | "fail" = "fail";
    receiver.onComplete((r) => {
      done = r.ok ? "ok" : "fail";
    });
    receiver.start(a);
    const sender = new StreamSender(sessionId, sessionKey.key, arraySource(data, "empty.bin"));
    sender.run(b);
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(done).toBe("ok");
  });

it("broadcasts in noAck mode: cycles every chunk per pass, receiver completes on pass 1, sender stops after maxPasses", async () => {
    const data = new Uint8Array(300);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    const kp = keypair();
    const sessionId = "broadcast-session";
    const sessionKey = deriveKxSessionKey(sessionId, kp.publicKey, kp.secretKey);
    const recorder = new RecordTransport();
    const receiver = new StreamReceiver(sessionId, sessionKey.key);
    const captured = {
      outcome: null as SessionOutcome | null,
      doneCount: 0,
      lastStats: null as ProgressStats | null,
    };
    receiver.onComplete((r) => {
      captured.outcome = r;
    });
    receiver.start(recorder);

    const sender = new StreamSender(sessionId, sessionKey.key, arraySource(data, "bcast.bin"), {
      chunkSize: 64,
      noAck: true,
      maxPasses: 3,
      onEvent: (e) => {
        if (e.type === "done") captured.doneCount++;
        if (e.type === "stats") captured.lastStats = e.stats;
      },
    });
    sender.run(recorder);

    const deadline = Date.now() + 5000;
    while (captured.doneCount === 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    expect(captured.doneCount).toBe(1);
    expect(sender.passCount).toBe(3);
    expect(captured.lastStats?.passes).toBe(3);

    const perPass = 1 + Math.ceil(data.length / 64);
    const parser = new FrameParser();
    const wire: Uint8Array[] = [];
    for (const f of recorder.frames) wire.push(...parser.push(f));
    const senderFrames = wire.filter((f) => {
      try {
        const m = parseMessage(f);
        return m.t === "hello" || m.t === "chunk";
      } catch {
        return false;
      }
    });
    // Receiver echoes have/done back onto the shared transport — ignore them.
    expect(senderFrames.length).toBe(3 * perPass);

    // Every pass opens with the header frame, then chunks in order.
    for (let pass = 0; pass < 3; pass++) {
      const off = pass * perPass;
      const hello = parseMessage(senderFrames[off]);
      expect(hello.t).toBe("hello");
      expect(hello.sid).toBe(sessionId);
      for (let c = 0; c < perPass - 1; c++) {
        const m = parseMessage(senderFrames[off + 1 + c]);
        expect(m.t).toBe("chunk");
        const p = fromBase64Url(m.p as string);
        expect(new DataView(p.buffer).getUint32(0, false)).toBe(c);
      }
    }

// The receiver decodes the whole file from pass 1 alone.
    expect(captured.outcome?.ok).toBe(true);
    if (captured.outcome?.ok) expect(captured.outcome.data).toEqual(data);
  });
});
