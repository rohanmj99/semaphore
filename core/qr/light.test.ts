import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frameMessage } from "../frames.ts";
import {
  LIGHT_FRAG_CAP,
  LIGHT_FRAG_MAGIC1,
  LIGHT_FRAG_MAGIC2,
  LIGHT_FRAG_SIZE,
  QrReassembler,
  LightTransport,
  startCameraDecoder,
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

  it("stays decodable with the custom design (ink/paper/rounded)", () => {
    const payload = new TextEncoder().encode("semaphore branded qr");
    const m = renderQr(payload);
    const img = paintQr(m, 8, 4, { ink: [23, 20, 36], paper: [248, 246, 240], round: 0.42 });
    expect(decodeQr(img.rgba, img.width, img.height)).toEqual(payload);
  });

  it("clamps the design rounding to a decodable range", () => {
    const payload = new TextEncoder().encode("round me");
    const m = renderQr(payload);
    const img = paintQr(m, 8, 4, { round: 9 });
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

/* ------------------------------------------------------------------ */
/* Camera preview lifecycle: a matcher's camera starts before any       */
/* preview box exists, and the receiver's preview box is recreated     */
/* between screens (React unmounts the old one). The video element     */
/* must stay connected to the document and re-play when re-attached,   */
/* otherwise the camera freezes black after the screen changes.        */
/* ------------------------------------------------------------------ */
describe("camera preview lifecycle", () => {
  interface FakeVideo extends Record<string, unknown> {
    paused: boolean;
    playCalls: number;
    play(): Promise<void>;
    pause(): void;
    remove(): void;
    replaceChildren(): void;
    setAttribute(): void;
  }

  let origDocument: unknown;
  let origNavigator: unknown;
  let streamObj: { getTracks: () => Array<{ stop(): void }> };
  let videos: FakeVideo[] = [];
  let bodyEl: FakeEl;

  interface FakeEl {
    tagName: string;
    style: Record<string, string>;
    children: unknown[];
    parentNode: FakeEl | null;
    appendChild(c: unknown): unknown;
    replaceChildren(...cs: unknown[]): void;
    remove(): void;
    setAttribute(k: string, v?: string): void;
    removeAttribute(k: string): void;
  }

  const fakeEl = (tag: string): FakeEl => {
    const children: unknown[] = [];
    const el: FakeEl = {
      tagName: tag,
      style: {},
      children,
      parentNode: null,
      appendChild(c: unknown) {
        (c as { parentNode: unknown }).parentNode = el;
        children.push(c);
        return c;
      },
      replaceChildren(...cs: unknown[]) {
        children.length = 0;
        for (const c of cs) {
          (c as { parentNode: unknown }).parentNode = el;
          children.push(c);
        }
      },
      remove() {
        if (el.parentNode) {
          const i = el.parentNode.children.indexOf(el);
          if (i >= 0) el.parentNode.children.splice(i, 1);
          el.parentNode = null;
        }
      },
      setAttribute() {},
      removeAttribute() {},
    };
    if (tag === "video") {
      const v = el as unknown as FakeVideo;
      v.paused = true;
      v.playCalls = 0;
      v.play = async () => {
        v.playCalls++;
        v.paused = false;
      };
      v.pause = () => {
        v.paused = true;
      };
      videos.push(v);
    }
    return el;
  };

  beforeEach(() => {
    videos = [];
    origDocument = (globalThis as Record<string, unknown>).document;
    streamObj = { getTracks: () => [{ stop() {} }] };
    bodyEl = fakeEl("body");
    (globalThis as Record<string, unknown>).document = {
      body: bodyEl,
      createElement: (tag: string) => fakeEl(tag),
    };
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: async () => streamObj } },
      configurable: true,
    });
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).document = origDocument;
    delete (globalThis as Record<string, unknown>).navigator;
    void origNavigator;
  });

  it("parks a preview-less camera in a hidden host so play() works from the start", async () => {
    const cam = startCameraDecoder(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(videos.length).toBe(1);
    const video = videos[0];
    expect(video).toBeDefined();
    expect(video.playCalls).toBe(1);
    expect(video.paused).toBe(false);
    // Still connected to the document (hidden host), never detached.
    expect((video.parentNode as { tagName: string }).tagName).toBe("div");
    expect(bodyEl.children).toContain(video.parentNode);
    cam.stop();
  });

  it("resumes the camera when the preview is re-created between screens", async () => {
    const cam = startCameraDecoder(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const video = videos[0];

    const waiting = fakeEl("div");
    cam.attachPreview(waiting as unknown as HTMLElement);
    expect((video.parentNode as { tagName: string }).tagName).toBe("div");
    expect(video.playCalls).toBe(1); // already playing — no extra play()

    // The waiting screen unmounts: the preview div (and the video inside it)
    // leaves the DOM. Browsers pause the video when it is detached.
    waiting.remove();
    video.paused = true;

    const transfer = fakeEl("div");
    cam.attachPreview(transfer as unknown as HTMLElement);
    // The fix re-issues play() on re-attach so the camera isn't black.
    expect(video.playCalls).toBeGreaterThanOrEqual(2);
    expect(video.paused).toBe(false);
    expect((video.parentNode as { tagName: string }).tagName).toBe("div");
    expect(transfer.children).toContain(video);
    cam.stop();
  });
});