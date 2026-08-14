import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { compress, decompress } from "./compression.ts";

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

describe("compression invariants", () => {
  it("leaves tiny inputs uncompressed but round-trips them", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const c = compress(input);
    expect(c.algo).toBe("none");
    expect(decompress(c)).toEqual(input);
  });

  it("round-trips compressible data via deflate or zip", () => {
    const input = new TextEncoder().encode("semaphore ".repeat(2000));
    const c = compress(input);
    expect(["deflate", "zip"]).toContain(c.algo);
    expect(c.data.length).toBeLessThan(input.length);
    expect(decompress(c)).toEqual(input);
  });

  it("round-trips incompressible binary without growing it", () => {
    const input = randomBytes(64 * 1024);
    const c = compress(input);
    expect(c.data.length).toBeLessThanOrEqual(input.length);
    expect(decompress(c)).toEqual(input);
  });

  it("round-trips across the 32-byte threshold and empty input", () => {
    for (const n of [31, 32, 33, 256, 4096]) {
      const input = randomBytes(n, n);
      expect(decompress(compress(input))).toEqual(input);
    }
    const empty = new Uint8Array(0);
    expect(decompress(compress(empty))).toEqual(empty);
  });

  it("empty zip payload fails loudly", () => {
    expect(() => decompress({ algo: "zip", data: zipSync({}) })).toThrow();
  });
});