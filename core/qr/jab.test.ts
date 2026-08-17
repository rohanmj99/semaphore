import { describe, expect, it } from "vitest";
import { JAB_PALETTE, JAB_SIDES, decodeJab, encodeJab, paintJab, RS_DATA } from "./jab.ts";

function dataOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

function roundTrip(payload: Uint8Array, scale: number): Uint8Array | null {
  const m = encodeJab(payload);
  const img = paintJab(m, scale, 4);
  return decodeJab(img.rgba, img.width, img.height);
}

function rotate180(rgba: Uint8ClampedArray, w: number, h: number): { rgba: Uint8ClampedArray; w: number; h: number } {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = ((h - 1 - y) * w + (w - 1 - x)) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return { rgba: out, w, h };
}

/** Simulate a camera's warm tint + brightness shift (linear per channel). */
function tint(rgba: Uint8ClampedArray, gains: [number, number, number], offset: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, rgba[i] * gains[0] + offset));
    out[i + 1] = Math.max(0, Math.min(255, rgba[i + 1] * gains[1] + offset));
    out[i + 2] = Math.max(0, Math.min(255, rgba[i + 2] * gains[2] + offset));
    out[i + 3] = 255;
  }
  return out;
}

describe("jab codec", () => {
  it("encodes a payload into an 8-color grid and decodes it back", () => {
    for (const n of [5, 100, 300, 1040, 1400]) {
      const payload = dataOf(n, n + 1);
      const got = roundTrip(payload, 8);
      expect(got).not.toBeNull();
      expect(got).toEqual(payload);
    }
  });

  it("picks the smallest grid that fits the payload", () => {
    const caps: Array<[number, number]> = [
      [10, 32],
      [189, 32],
      [190, 40],
      [571, 48],
      [1144, 64],
      [1400, 80],
    ];
    for (const [bytes, side] of caps) {
      const m = encodeJab(dataOf(bytes, 3));
      expect(m.size).toBe(side + 14);
    }
  });

  it("rejects payloads too large for the biggest grid", () => {
    const cap = 1717;
    expect(() => encodeJab(dataOf(cap + 1, 1))).toThrow();
  });

  it("decodes across a range of module scales", () => {
    const payload = new TextEncoder().encode("semaphore scales");
    for (const scale of [3, 4, 6, 10]) {
      const got = roundTrip(payload, scale);
      expect(got).not.toBeNull();
      expect(got).toEqual(payload);
    }
  });

  it("decodes a code embedded in a larger frame (not full-screen)", () => {
    const payload = dataOf(200, 9);
    const m = encodeJab(payload);
    const img = paintJab(m, 6, 4);
    const W = img.width + 160;
    const H = img.height + 120;
    const frame = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < frame.length; i += 4) {
      frame[i] = 255;
      frame[i + 1] = 255;
      frame[i + 2] = 255;
      frame[i + 3] = 255;
    }
    const ox = 90;
    const oy = 40;
    for (let y = 0; y < img.height; y++) {
      frame.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + oy) * W + ox) * 4);
    }
    const got = decodeJab(frame, W, H);
    expect(got).toEqual(payload);
  });

  it("decodes a 180° rotated code (camera held upside down)", () => {
    const payload = dataOf(700, 21);
    const m = encodeJab(payload);
    const img = paintJab(m, 8, 4);
    const rot = rotate180(img.rgba, img.width, img.height);
    const got = decodeJab(rot.rgba, rot.w, rot.h);
    expect(got).toEqual(payload);
  });

  it("survives camera tint and brightness shifts", () => {
    const payload = dataOf(500, 33);
    const m = encodeJab(payload);
    const img = paintJab(m, 8, 4);
    // Warm tint, slightly dim, lifted blacks.
    const warped = tint(img.rgba, [1.08, 0.97, 0.85], 14);
    const got = decodeJab(warped, img.width, img.height);
    expect(got).toEqual(payload);
  });

  it("survives per-pixel sensor noise", () => {
    const payload = dataOf(400, 44);
    const m = encodeJab(payload);
    const img = paintJab(m, 8, 4);
    const noisy = new Uint8ClampedArray(img.rgba.length);
    let s = 777;
    for (let i = 0; i < img.rgba.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      noisy[i] = Math.max(0, Math.min(255, img.rgba[i] + ((s % 25) - 12)));
    }
    const got = decodeJab(noisy, img.width, img.height);
    expect(got).toEqual(payload);
  });

  it("corrects scattered module errors via Reed–Solomon", () => {
    const payload = dataOf(600, 55);
    const m = encodeJab(payload);
    // Flip a few data-module colors to a wrong color (deterministic RNG).
    const rng = (state: number) => {
      let s = state >>> 0;
      return () => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return s >>> 0;
      };
    };
    const next = rng(4242);
    let flips = 0;
    for (let y = 7; y < m.size - 7 && flips < 8; y++) {
      for (let x = 7; x < m.size - 7 && flips < 8; x++) {
        m.colors[y * m.size + x] = (next() % 8 + 1) & 7;
        flips++;
      }
    }
    const img = paintJab(m, 8, 4);
    const got = decodeJab(img.rgba, img.width, img.height);
    expect(got).toEqual(payload);
  });

  it("rejects frames with too many errors to correct", () => {
    const payload = dataOf(1400, 66);
    const m = encodeJab(payload);
    const rng = (state: number) => {
      let s = state >>> 0;
      return () => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return s >>> 0;
      };
    };
    const next = rng(9090);
    const side = m.size - 14;
    const dataStart = 7;
    for (let k = 0; k < side * side; k++) {
      // Overwrite most of the data region with garbage colors — far beyond
      // the RS correction capacity of every block.
      if (next() % 3 !== 0) continue;
      const dx = k % side;
      const dy = Math.floor(k / side);
      m.colors[(dy + dataStart) * m.size + (dx + dataStart)] = next() & 7;
    }
    const img = paintJab(m, 8, 4);
    const got = decodeJab(img.rgba, img.width, img.height);
    // Either it fails outright, or it returns the right payload — it must
    // never return a corrupt payload.
    if (got !== null) expect(got).toEqual(payload);
  });

  it("rejects garbage frames", () => {
    const noise = new Uint8ClampedArray(320 * 240 * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 17) & 0xff;
    expect(decodeJab(noise, 320, 240)).toBeNull();
    const white = new Uint8ClampedArray(320 * 240 * 4);
    for (let i = 0; i < white.length; i += 4) {
      white[i] = 255;
      white[i + 1] = 255;
      white[i + 2] = 255;
      white[i + 3] = 255;
    }
    expect(decodeJab(white, 320, 240)).toBeNull();
  });

  it("uses all eight palette colors in a large payload", () => {
    const m = encodeJab(dataOf(1400, 77));
    const seen = new Set<number>();
    for (let i = 0; i < m.colors.length; i++) seen.add(m.colors[i] & 7);
    expect(seen.size).toBe(8);
    expect(JAB_PALETTE.length).toBe(8);
  });

  it("fits a full 1400-byte fragment at camera-friendly scale", () => {
    const payload = dataOf(1400, 88);
    const m = encodeJab(payload);
    expect(m.size).toBe(94);
    const img = paintJab(m, 4, 4);
    expect(img.width).toBe((94 + 8) * 4);
    const got = decodeJab(img.rgba, img.width, img.height);
    expect(got).toEqual(payload);
  });

  it("supports every advertised grid side", () => {
    for (const side of JAB_SIDES) {
      const maxData = Math.floor(Math.floor((3 * side * side) / 8) / 255) * RS_DATA - 2;
      const payload = dataOf(maxData, side);
      const got = roundTrip(payload, 6);
      expect(got).toEqual(payload);
    }
  });
});