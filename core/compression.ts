import { deflate, inflate } from "pako";
import { zipSync, unzipSync } from "fflate";

export type CompressionAlgo = "none" | "deflate" | "zip";

export interface Compressed {
  algo: CompressionAlgo;
  data: Uint8Array;
}

export function compress(input: Uint8Array): Compressed {
  if (input.length < 32) return { algo: "none", data: input };
  const deflated = deflate(input, { level: 9 });
  const zipped = zipSync({ file: input }, { level: 9 });
  const best = zipped.length < deflated.length ? zipped : deflated;
  const algo: CompressionAlgo = zipped.length < deflated.length ? "zip" : "deflate";
  if (best.length >= input.length) return { algo: "none", data: input };
  return { algo, data: best };
}

export function decompress(c: Compressed): Uint8Array {
  if (c.algo === "none") return c.data;
  if (c.algo === "deflate") return inflate(c.data);
  const entries = unzipSync(c.data);
  const first = Object.values(entries)[0];
  if (!first) throw new Error("empty zip payload");
  return first;
}