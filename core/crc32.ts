const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Running CRC update (unfinalized — use finish() at the end). */
export function crc32Update(seed: number, bytes: Uint8Array): number {
  let c = seed;
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c;
}

export function crc32Finish(c: number): number {
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32(bytes: Uint8Array, seedSymbol = -1): number {
  const seed = seedSymbol < 0 ? 0xffffffff : seedSymbol;
  return crc32Finish(crc32Update(seed, bytes));
}