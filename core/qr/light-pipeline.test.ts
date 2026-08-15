import { describe, expect, it } from "vitest";
import { frameMessage, parseMessage } from "../frames.ts";
import {
  advertiseLight,
  fragmentLight,
  LightTransport,
  matchLightSession,
  paintQr,
  renderQr,
} from "./light.ts";
import { deriveKxSessionKey, keypair } from "../crypto.ts";
import { fromBase64Url, toBase64Url } from "../util.ts";
import { encodeHeaderWire, ManifestBuilder } from "../chunker.ts";
import { StreamReceiver } from "../session.ts";

function feedFrag(t: LightTransport, frag: Uint8Array) {
  const m = renderQr(frag);
  const img = paintQr(m, 8);
  t.feedImage(new Uint8ClampedArray(img.rgba), img.width, img.height);
}

/** Full light-channel pipeline with real keys: match → go → hello → chunks,
 *  all round-tripped through the camera transport (QR paint → decode). This
 *  is the regression test for the transport contract: light delivers frames
 *  unwrapped, and StreamReceiver must accept them without re-parsing. */
describe("light receive pipeline", () => {
  it("completes a transfer through the matcher's camera transport", async () => {
    const SID = "0123456789abcdef";
    const senderKp = keypair();
    const session = {
      sessionId: SID,
      wordPair: "crafted-test",
      senderFingerprint: "feedbeef",
      senderPub: toBase64Url(senderKp.publicKey),
      file: { name: "crafted.txt", size: 123 },
      seenAt: Date.now(),
    };

    const matcher = matchLightSession(session);
    let goHandled = false;
    let receiver: StreamReceiver | null = null;
    const events: string[] = [];
    matcher.onGo(() => {
      goHandled = true;
      const pin = matcher.pin!;
      receiver = new StreamReceiver(pin.sessionId, pin.sessionKey, (e) => {
        const phase = (e as { phase?: string }).phase ?? "";
        events.push(e.type === "error" ? "error:" + e.message : phase ? e.type + ":" + phase : e.type);
        if (e.type === "error") throw new Error("receiver error: " + e.message);
      });
      receiver.start(pin.channel);
    });

    matcher.confirm();
    expect(matcher.pin).not.toBeNull();
    const matchFrag = matcher.display!.currentFrag();
    expect(matchFrag).not.toBeNull();
    const matchMsg = parseMessage(matchFrag!.slice(10));
    expect(matchMsg.t).toBe("match");
    expect(matchMsg.sid).toBe(SID);
    const receiverPub = matchMsg.pub as string;

    const sessionKey = deriveKxSessionKey(SID, fromBase64Url(receiverPub), senderKp.secretKey).key;
    expect(matcher.pin!.sessionKey).toEqual(sessionKey);

    const bytes = new TextEncoder().encode("semaphore light e2e hello " + "y".repeat(500));
    const source = {
      name: "crafted.txt",
      mime: "text/plain",
      size: bytes.length,
      async slice(s: number, e: number) {
        return bytes.slice(s, e);
      },
    };
    const builder = new ManifestBuilder(source, SID, sessionKey, 8192);
    const header = await builder.buildHeader();
    header.sessionId = SID;
    const channel = matcher.pin!.channel as LightTransport;

    const send = (frame: Uint8Array) => {
      for (const f of fragmentLight(frame)) feedFrag(channel, f);
    };
    send(frameMessage(new TextEncoder().encode(JSON.stringify({ t: "go", sid: SID }))));
    await new Promise((r) => setTimeout(r, 10));
    expect(goHandled).toBe(true);

    const helloFrame = frameMessage(
      new TextEncoder().encode(
        JSON.stringify({ t: "hello", sid: SID, h: toBase64Url(encodeHeaderWire(header, sessionKey)) }),
      ),
    );
    send(helloFrame);

    const total = builder.meta.totalChunks;
    for (let i = 0; i < total; i++) {
      const { ciphertext, crc32 } = await builder.prepareChunk(i);
      const payload = new Uint8Array(8 + ciphertext.length);
      new DataView(payload.buffer).setUint32(0, i, false);
      new DataView(payload.buffer).setUint32(4, crc32, false);
      payload.set(ciphertext, 8);
      send(frameMessage(new TextEncoder().encode(JSON.stringify({ t: "chunk", sid: SID, p: toBase64Url(payload) }))));
    }

    const result = await new Promise<{ ok: boolean; data?: Uint8Array }>((resolve) => {
      receiver!.onComplete((r) => resolve(r.ok ? { ok: true, data: r.data } : { ok: false }));
      setTimeout(() => resolve({ ok: false }), 5000);
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(bytes);
    expect(events).toContain("phase:running");
    expect(events.some((e) => e.startsWith("chunk"))).toBe(true);
    expect(events).toContain("phase:verifying");
    matcher.cancel();
  });

  it("advertiseLight reannounces after a completed broadcast", async () => {
    const sender = advertiseLight({ name: "again.txt", size: 10 });
    const matches: string[] = [];
    sender.onMatch((p) => matches.push(p.receiverFingerprint));

    const announceFrag = sender.display.currentFrag();
    expect(announceFrag).not.toBeNull();
    const announce = JSON.parse(new TextDecoder().decode(announceFrag!.slice(10))) as { sessionId: string; wordPair: string };
    expect(announce.sessionId).toBe(sender.sessionId);
    expect(announce.wordPair).toBe(sender.wordPair);

    // A receiver matches, then the broadcast finishes; reannounce must reset
    // the queue so the session is discoverable again.
    sender.reannounce();
    const frag2 = sender.display.currentFrag();
    expect(frag2).not.toBeNull();
    const msg2 = JSON.parse(new TextDecoder().decode(frag2!.slice(10))) as { sessionId: string; wordPair: string };
    expect(msg2.sessionId).toBe(sender.sessionId);
    expect(msg2.wordPair).toBe(sender.wordPair);
    sender.stop();
  });

  it("matchLightSession exposes camera controls", async () => {
    const kp = keypair();
    const session = {
      sessionId: "abcdefabcdef1234",
      wordPair: "camera-test",
      senderFingerprint: "cafebabe",
      senderPub: toBase64Url(kp.publicKey),
      file: null,
      seenAt: Date.now(),
    };
    const matcher = matchLightSession(session);
    expect(typeof matcher.switchCamera).toBe("function");
    expect(typeof matcher.attachPreview).toBe("function");
    expect(matcher.lastDecodeMs()).toBeGreaterThanOrEqual(0);
    matcher.cancel();
  });
});