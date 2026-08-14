export function u32be(n: number, out = new Uint8Array(4), off = 0): Uint8Array {
  out[off] = (n >>> 24) & 0xff;
  out[off + 1] = (n >>> 16) & 0xff;
  out[off + 2] = (n >>> 8) & 0xff;
  out[off + 3] = n & 0xff;
  return out;
}

export function u32le(n: number, out = new Uint8Array(4), off = 0): Uint8Array {
  out[off] = n & 0xff;
  out[off + 1] = (n >>> 8) & 0xff;
  out[off + 2] = (n >>> 16) & 0xff;
  out[off + 3] = (n >>> 24) & 0xff;
  return out;
}

export function u64be(n: number, out = new Uint8Array(8), off = 0): Uint8Array {
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  u32be(hi >>> 0, out, off);
  u32be(lo, out, off + 4);
  return out;
}

export function readU32be(b: Uint8Array, off = 0): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

export function readU32le(b: Uint8Array, off = 0): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += CHARS[b0 >> 2];
    s += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) {
      s += CHARS[((b1 & 15) << 2) | (b2 >> 6)];
      if (i + 2 < bytes.length) s += CHARS[b2 & 63];
    }
  }
  return s;
}

export function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(((clean.length * 6) / 8) | 0);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const idx = CHARS.indexOf(clean[i]);
    if (idx < 0) throw new Error("invalid base64url character");
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function concatB(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function nextId(): string {
  const b = new Uint8Array(8);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(b);
    return hex(b);
  }
  return Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0");
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  const text = Math.round(v * 10) / 10;
  return `${text % 1 === 0 ? text.toFixed(0) : text.toFixed(1)} ${units[u]}`;
}