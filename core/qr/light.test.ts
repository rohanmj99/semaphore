import { describe, expect, it } from "vitest";
import { frameMessage } from "../frames.ts";
import {
  LIGHT_FRAG_CAP,
  LIGHT_FRAG_MAGIC1,
  LIGHT_FRAG_MAGIC2,
  LIGHT_FRAG_SIZE,
  QrReassembler,
  LightTransport,
  fragmentLight,
  paintQr,
  renderQr,
  decodeQr,
} from "./light.ts";

function imageOf(payload: Uint8Array, scale = 8) {
  const m = renderQr(payload);
  return { matrix: m, img: paintQr(m, scale) };
}

function roundTrip(payload: Uint8Array, scale = 8): Uint8Array | null {
  const { img } = imageOf(payload, scale);
  return decodeQr(img.rgba, img.width, img.height);
}

describe("light codec", () => {
  it("fragments a wire message into QR payloads", () => {
    const frame = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "go", sid: "b".repeat(16) })));
    const frags = fragmentLight(frame);
    expect(frags.length).toBeGreaterThan(0);
    expect(frags[0][0]).toBe(LIGHT_FRAG_MAGIC1);
    expect(frags[0][1]).toBe(LIGHT_FRAG_MAGIC2);
    expect(frags[0].length).toBeLessThanOrEqual(LIGHT_FRAG_SIZE);
    const re = new QrReassembler();
    const delivered: Uint8Array[] = [];
    for (const f of frags) {
      const w = re.push(f);
      if (w) delivered.push(w);
    }
    expect(delivered).toEqual([frame]);
  });

  it("fragments a large message across multiple QRs", () => {
    const big = new Uint8Array(9000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    const frags = fragmentLight(big);
    expect(frags.length).toBeGreaterThan(1);
    for (const f of frags) {
      expect(f.length).toBeGreaterThan(6);
      expect(f[5]).toBeLessThanOrEqual(LIGHT_FRAG_CAP);
    }
    const re = new QrReassembler();
    const delivered: Uint8Array[] = [];
    for (const f of frags) {
      const w = re.push(f);
      if (w) delivered.push(w);
    }
    expect(delivered).toEqual([big]);
  });

  it("drops a partial message when a mid fragment is lost", () => {
    const frame = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "ready", pub: "x".repeat(3000), fp: "y" })));
    const frags = fragmentLight(frame);
    const re = new QrReassembler();
    const delivered: Uint8Array[] = [];
    for (let i = 0; i < frags.length; i++) {
      if (i === 1) continue;
      const w = re.push(frags[i]);
      if (w) delivered.push(w);
    }
    expect(delivered).toEqual([]);
    // The next pass recovers: seq 0 starts a fresh message.
    for (const f of frags) {
      const w = re.push(f);
      if (w) delivered.push(w);
    }
    expect(delivered).toEqual([frame]);
  });

  it("rejects malformed fragments", () => {
    const re = new QrReassembler();
    expect(re.push(new Uint8Array([0x53, 0x51, 0, 0, 0, 0]))).toBeNull(); // totalLen 0
    expect(re.push(new Uint8Array([0x53, 0x51, 0, 0x10, 0, 1, 65]))).toBeNull(); // len beyond cap
    expect(re.push(new Uint8Array([0x51, 0x53, 0, 1, 0, 1, 65]))).toBeNull(); // wrong magic
    expect(re.push(new Uint8Array(2))).toBeNull();
  });
});

describe("qr render + decode", () => {
  it("round-trips a payload through render → paint → jsQR", () => {
    const payload = new Uint8Array(300);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 7) & 0xff;
    const got = roundTrip(payload);
    expect(got).not.toBeNull();
    expect(got).toEqual(payload);
  });

  it("round-trips a full-size fragment", () => {
    const payload = new Uint8Array(LIGHT_FRAG_SIZE);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const got = roundTrip(payload, 6);
    expect(got).not.toBeNull();
    expect(got).toEqual(payload);
  });

  it("decodes the painted image by eye-friendly scale", () => {
    const payload = new TextEncoder().encode("semaphore light channel");
    const { img } = imageOf(payload, 4);
    expect(img.width).toBe(img.height);
    expect(decodeQr(img.rgba, img.width, img.height)).toEqual(payload);
  });
});

describe("light transport", () => {
  it("buffers one message for display and cycles fragments", () => {
    const tx = new LightTransport({ tx: true, rx: false });
    const a = new TextEncoder().encode("alpha");
    const b = new TextEncoder().encode("beta");
    tx.send(a);
    const first = tx.currentFrag();
    expect(first).not.toBeNull();
    expect(first).toEqual(fragmentLight(a)[0]);
    tx.advance();
    tx.advance();
    tx.send(b);
    expect(tx.currentFrag()).toEqual(fragmentLight(b)[0]);
    expect(tx.fragmentCount).toBe(1);
    tx.close();
  });

  it("delivers frames fed as camera images", () => {
    const rx = new LightTransport({ tx: false, rx: true });
    const body = new TextEncoder().encode(JSON.stringify({ t: "match", sid: "s1", pub: "p", fp: "f" }));
    const frame = frameMessage(body);
    const delivered: Uint8Array[] = [];
    const unsub = rx.onMessage((f) => delivered.push(f));
    for (const frag of fragmentLight(frame)) {
      const { img } = imageOf(frag, 6);
      rx.feedImage(img.rgba, img.width, img.height);
    }
    expect(delivered).toEqual([body]);
    unsub();
    rx.close();
  });

  it("ignores garbage camera images", () => {
    const rx = new LightTransport({ tx: false, rx: true });
    const noise = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 17) & 0xff;
    const delivered: Uint8Array[] = [];
    rx.onMessage((f) => delivered.push(f));
    for (let i = 0; i < 5; i++) rx.feedImage(noise, 64, 64);
    expect(delivered).toEqual([]);
    rx.close();
  });
});