import { describe, expect, it } from "vitest";
import { HaveBitmap } from "./have-bitmap.ts";

describe("have bitmap (resume/repair)", () => {
  it("tracks set/clear and missing runs", () => {
    const b = new HaveBitmap(10);
    expect(b.missingCount()).toBe(10);
    b.set(0);
    b.set(2);
    b.set(7);
    expect(b.has(2)).toBe(true);
    expect(b.has(1)).toBe(false);
    expect(b.count).toBe(3);
    expect(b.missing()).toEqual([1, 3, 4, 5, 6, 8, 9]);
    expect(b.all).toBe(false);
  });

  it("round-trips through bytes (with totalChunks)", () => {
    const b = new HaveBitmap(33);
    for (const i of [0, 1, 8, 9, 31, 32]) b.set(i);
    const restored = HaveBitmap.fromBytes(b.toBytes());
    expect(restored.totalChunks).toBe(33);
    for (let i = 0; i < 33; i++) {
      expect(restored.has(i)).toBe(b.has(i));
    }
  });

  it("rejects malformed byte payloads", () => {
    expect(() => HaveBitmap.fromBytes(new Uint8Array(4))).toThrow();
  });

  it("rebuild keeps existing bits when the manifest arrives later", () => {
    const b = new HaveBitmap(8);
    b.set(3);
    b.rebuild(40);
    expect(b.has(3)).toBe(true);
    expect(b.missingCount()).toBe(39);
  });

  it("encodes missing runs compactly for pairing frames", () => {
    const b = new HaveBitmap(12);
    b.set(0);
    b.set(1);
    b.set(4);
    b.set(5);
    b.set(6);
    // missing: 2,3,7,8,9,10,11 → runs "2-3,7-11"
    expect(b.toRleString()).toBe("2-3,7-11");
  });
});