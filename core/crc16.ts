const TABLE = new Uint16Array(256).map((_, i) => {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  return c;
});

export function crc16(bytes: Uint8Array): number {
  let c = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    c = ((c << 8) & 0xffff) ^ TABLE[((c >>> 8) ^ bytes[i]) & 0xff];
  }
  return (c ^ 0xffff) & 0xffff;
}