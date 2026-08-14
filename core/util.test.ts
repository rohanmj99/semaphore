import { describe, expect, it } from "vitest";
import { crc32, crc32Finish, crc32Update } from "./crc32.ts";
import { crc16 } from "./crc16.ts";
import { compress, decompress } from "./compression.ts";
import { u32be, readU32be, toBase64Url, fromBase64Url, fmtBytes } from "./util.ts";
import { HaveBitmap } from "./have-bitmap.ts";
import { frameMessage, FrameParser, encodeMessage, parseMessage } from "./frames.ts";

describe("crc32", () => {
  it("matches known-answer vector", () => {
    const input = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    expect(crc32(input)).toBe(0x414fa339);
  });
  it("is seed-continuable across slices", () => {
    const data = new TextEncoder().encode("semaphore protocol" + "x".repeat(1000));
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i += 100) {
      c = crc32Update(c, data.subarray(i, i + 100));
    }
    expect(crc32Finish(c)).toBe(crc32(data));
  });
  it("handles empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("crc16", () => {
  it("detects single-bit flips", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const b = new Uint8Array([1, 2, 3, 4, 5, 7]);
    expect(crc16(a)).not.toBe(crc16(b));
  });
});

describe("compression", () => {
  it("tries both deflate and zip, keeps smaller", () => {
    const data = new TextEncoder().encode("hello semaphore ".repeat(200));
    const comp = compress(data);
    expect(comp.data.length).toBeLessThan(data.length);
    expect(decompress({ algo: comp.algo, data: comp.data })).toEqual(data);
  });
  it("does not expand incompressible data", () => {
    const data = new Uint8Array(64).map((_, i) => i % 256);
    const comp = compress(data);
    expect(comp.data).toEqual(data);
    expect(comp.algo).toBe("none");
  });
});

describe("util", () => {
  it("base64url round-trips binary", () => {
    const b = new Uint8Array(300).map((_, i) => (i * 7) % 256);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
  });
  it("u32 round-trips", () => {
    expect(readU32be(u32be(0xdeadbeef))).toBe(0xdeadbeef);
  });
  it("fmtBytes", () => {
    expect(fmtBytes(1024)).toBe("1 KB");
    expect(fmtBytes(1)).toBe("1 B");
  });
});

describe("HaveBitmap", () => {
  it("tracks, dedupes and round-trips", () => {
    const bm = new HaveBitmap(100);
    expect(bm.all).toBe(false);
    for (let i = 0; i < 100; i += 2) bm.set(i);
    expect(bm.count).toBe(50);
    expect(bm.missing()).toEqual(Array.from({ length: 50 }, (_, i) => i * 2 + 1));
    const back = HaveBitmap.fromBytes(bm.toBytes());
    expect(back.totalChunks).toBe(100);
    expect(back.count).toBe(50);
    expect(back.has(2)).toBe(true);
  });
  it("rle string is lossy but parseable", () => {
    const bm = new HaveBitmap(10);
    bm.set(4);
    bm.set(5);
    bm.set(6);
    expect(bm.toRleString()).toBe("0-3,7-9");
  });
});

describe("framing", () => {
  it("reassembles split frames", () => {
    const msg = encodeMessage({ t: "chunk", sid: "abc", p: "x" });
    const parser = new FrameParser();
    expect(parser.push(msg.subarray(0, 3))).toEqual([]);
    expect(parser.push(msg.subarray(3, 17))).toEqual([]);
    const rest = parser.push(msg.subarray(17));
    expect(rest.length).toBe(1);
    expect(parseMessage(rest[0])).toEqual({ t: "chunk", sid: "abc", p: "x" });
  });
  it("rejects oversized frames", () => {
    const parser = new FrameParser();
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 0x04000001, false);
    expect(() => parser.push(bad)).toThrow(/too large/);
  });
  it("frameMessage wraps payloads with a length prefix", () => {
    const payload = new TextEncoder().encode(JSON.stringify({ t: "hello" }));
    const wrapped = frameMessage(payload);
    expect(new DataView(wrapped.buffer).getUint32(0, false)).toBe(payload.length);
    const parser = new FrameParser();
    const frames = parser.push(wrapped);
    expect(frames.length).toBe(1);
    expect(parseMessage(frames[0])).toEqual({ t: "hello" });
  });
});