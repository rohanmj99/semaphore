import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto } from "./crypto.ts";
import {
  advertiseSender,
  matchSession,
  scanForSessions,
  type VisibleSession,
} from "./pairing.ts";
import { StreamReceiver, StreamSender } from "./session.ts";
import { arraySource } from "./chunker.ts";
import type { TransportEndpoint } from "./transports.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => T | null, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = probe();
    if (v !== null && v !== undefined && (typeof v !== "boolean" || v)) return v;
    await sleep(50);
  }
  throw new Error("condition not met within timeout");
}

describe("loopback pairing over BroadcastChannel", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("announces, matches, and transfers 100 KB with both-side confirmation", async () => {
    const data = new Uint8Array(100 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 73 + (i >> 4)) & 0xff;

    const sender = advertiseSender({ name: "loop.bin", size: data.length });
    try {
      let visible: VisibleSession | null = null;
      const unsub = scanForSessions((list) => {
        const hit = list.find((s) => s.sessionId === sender.sessionId);
        if (hit) visible = hit;
      });
      try {
        const found = await waitFor<VisibleSession>(() => visible);
        expect(found.wordPair).toBe(sender.wordPair);
        expect(found.file?.name).toBe("loop.bin");

        const matcher = matchSession(found);
        let received: { ok: boolean; len: number } | null = null;
        matcher.onGo(() => {
          const room = matcher.pin;
          if (!room) throw new Error("pin missing");
          const recv = new StreamReceiver(room.sessionId, room.sessionKey);
          recv.onComplete((r) => {
            received = { ok: r.ok, len: r.ok ? r.data.length : 0 };
          });
          recv.start(room.channel);
          matcher.postReady();
        });
        matcher.confirm();
        const match = await new Promise<{ receiverFingerprint: string }>((res) => {
          sender.onMatch((peer) => res(peer));
        });
        expect(match.receiverFingerprint.length).toBe(12);
        sender.notifyGo();

        const readyPromise = new Promise<{ sessionKey: Uint8Array; channel: TransportEndpoint }>((res) => {
          sender.start((keys) => res(keys));
        });
        const keys = await readyPromise;
        const senderStream = new StreamSender(found.sessionId, keys.sessionKey, arraySource(data, "loop.bin"));
        senderStream.run(keys.channel);

        const result = await waitFor<{ ok: boolean; len: number }>(() => received);
        expect(result.ok).toBe(true);
        expect(result.len).toBe(data.length);
      } finally {
        unsub();
      }
    } finally {
      sender.stop();
    }
  }, 30000);

  it("rejects a session when the announcement vanishes (TTL)", async () => {
    const sender = advertiseSender(null);
    const seen: string[] = [];
    const unsub = scanForSessions((list) => {
      seen.length = 0;
      for (const s of list) seen.push(s.sessionId);
    });
    try {
      await waitFor(() => (seen.includes(sender.sessionId) ? true : null), 3000);
      sender.stop();
      const gone = await waitFor(() => (seen.includes(sender.sessionId) ? null : true), 4000);
      expect(gone).toBe(true);
    } finally {
      unsub();
    }
  }, 15000);
});