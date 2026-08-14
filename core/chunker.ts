import type { ManifestHeader, TransferMeta } from "./types.ts";
export type { ManifestHeader } from "./types.ts";
import { compress, type Compressed } from "./compression.ts";
import { chunkNonce, openSeal, sanitizeFilename, seal, sealedNonce } from "./crypto.ts";
import { crc32, crc32Finish, crc32Update } from "./crc32.ts";

export const DEFAULT_CHUNK_SIZE = 256 * 1024;
export const CRC_STEP = 512 * 1024;

export interface SliceSource {
  readonly size: number;
  name?: string;
  mime?: string;
  slice(start: number, end: number): Uint8Array | Promise<Uint8Array>;
}

export function arraySource(
  data: Uint8Array,
  name = "file.bin",
  mime = "application/octet-stream",
): SliceSource {
  return { size: data.length, name, mime, slice: (s, e) => data.subarray(s, e) };
}

export function fileSource(
  file: { size: number; name?: string; type?: string; slice: (s: number, e: number) => Blob },
): SliceSource {
  return {
    size: file.size,
    name: file.name,
    mime: file.type,
    async slice(s: number, e: number) {
      const blob = file.slice(s, e);
      if (blob.size === 0) return new Uint8Array(0);
      const buf = await blob.arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

export function totalChunksFor(size: number, chunkSize: number): number {
  if (size === 0) return 0;
  return Math.ceil(size / chunkSize);
}

export class ManifestBuilder {
  readonly meta: TransferMeta;
  readonly header: ManifestHeader;

  private readonly source: SliceSource;
  private readonly sessionKey: Uint8Array;
  private readonly chunkSize: number;
  private compiled: { compressed: Compressed | null } = { compressed: null };

  constructor(
    source: SliceSource,
    sessionId: string,
    sessionKey: Uint8Array,
    chunkSize = DEFAULT_CHUNK_SIZE,
  ) {
    this.source = source;
    this.sessionKey = sessionKey;
    this.chunkSize = chunkSize;
    const name = sanitizeFilename(source.name ?? "file.bin");
    this.meta = {
      filename: name,
      mime: source.mime ?? "application/octet-stream",
      originalSize: source.size,
      compressedSize: 0,
      crc32: 0,
      totalChunks: totalChunksFor(source.size, chunkSize),
      chunkSize,
    };
    this.header = {
      magic: "AB",
      version: 1,
      cipher: 1,
      filename: name,
      mime: this.meta.mime,
      originalSize: source.size,
      compressedSize: 0,
      crc32: 0,
      totalChunks: this.meta.totalChunks,
      chunkSize,
      senderFingerprint: "",
      sessionId,
    };
  }

  async originalCrc32(): Promise<number> {
    let c = 0xffffffff;
    for (let pos = 0; pos < this.source.size; pos += CRC_STEP) {
      const end = Math.min(pos + CRC_STEP, this.source.size);
      c = crc32Update(c, await this.source.slice(pos, end));
    }
    return crc32Finish(c);
  }

  async compressedWhole(): Promise<Compressed> {
    if (this.compiled.compressed) return this.compiled.compressed;
    const raw = await this.source.slice(0, this.source.size);
    const comp = compress(raw);
    this.compiled.compressed = comp;
    return comp;
  }

  async buildHeader(): Promise<ManifestHeader> {
    const [crc, comp] = await Promise.all([this.originalCrc32(), this.compressedWhole()]);
    this.header.crc32 = crc;
    this.header.compressedSize = comp.data.length;
    return this.header;
  }

  async prepareChunk(index: number): Promise<{ ciphertext: Uint8Array; crc32: number }> {
    const start = index * this.chunkSize;
    const end = Math.min(start + this.chunkSize, this.source.size);
    const raw = start < this.source.size ? await this.source.slice(start, end) : new Uint8Array(0);
    return { ciphertext: seal(this.sessionKey, chunkNonce(this.sessionKey, this.header.sessionId, index), raw), crc32: crc32(raw) };
  }
}

export function decryptChunk(
  sessionKey: Uint8Array,
  sessionId: string,
  index: number,
  ciphertext: Uint8Array,
  expectedCrc: number,
): Uint8Array | null {
  const plain = openSeal(sessionKey, chunkNonce(sessionKey, sessionId, index), ciphertext);
  if (!plain) return null;
  if (crc32(plain) !== expectedCrc) return null;
  return plain;
}

export function encodeHeaderWire(header: ManifestHeader, sessionKey: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const nonce = sealedNonce(sessionKey, `header:${header.sessionId}`);
  const sealed = seal(sessionKey, nonce, json);
  const out = new Uint8Array(30 + sealed.length);
  out[0] = 0x41; // A
  out[1] = 0x42; // B
  out[2] = header.version;
  out[3] = header.cipher;
  out.set(nonce, 4);
  out[28] = (sealed.length >> 8) & 0xff;
  out[29] = sealed.length & 0xff;
  out.set(sealed, 30);
  return out;
}

export type HeaderParseResult =
  | { ok: true; header: ManifestHeader }
  | { ok: false; reason: "badMagic" | "badVersion" | "badCipher" | "wrongKey" | "malformed"; detail?: string };

export function parseHeaderWire(
  wire: Uint8Array,
  sessionKey: Uint8Array,
  expectedSessionId?: string,
): HeaderParseResult {
  if (wire.length < 30 || wire[0] !== 0x41 || wire[1] !== 0x42) {
    return { ok: false, reason: "badMagic", detail: "not a Semaphore header" };
  }
  if (wire[2] !== 1) return { ok: false, reason: "badVersion" };
  const cipher = wire[3];
  if (cipher !== 1 && cipher !== 2) return { ok: false, reason: "badCipher" };
  const nonce = wire.slice(4, 28);
  const len = (wire[28] << 8) | wire[29];
  if (len === 0 || 30 + len > wire.length) return { ok: false, reason: "malformed" };
  const plain = openSeal(sessionKey, nonce, wire.slice(30, 30 + len));
  if (!plain) {
    return { ok: false, reason: "wrongKey", detail: "cannot open header" };
  }
  try {
    const obj = JSON.parse(new TextDecoder().decode(plain)) as ManifestHeader;
    if (obj.magic !== "AB") return { ok: false, reason: "badMagic" };
    if (expectedSessionId !== undefined && obj.sessionId !== expectedSessionId) {
      return { ok: false, reason: "wrongKey", detail: "session mismatch" };
    }
    return { ok: true, header: obj };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function verifyWholeFile(original: Uint8Array, header: ManifestHeader): boolean {
  return original.length === header.originalSize && crc32(original) === header.crc32;
}

export async function reassemble(
  chunks: ReadonlyMap<number, Uint8Array>,
  header: ManifestHeader,
  onProgress?: (receivedBytes: number) => void,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let received = 0;
  let size = 0;
  for (let i = 0; i < header.totalChunks; i++) {
    const c = chunks.get(i);
    if (!c) throw new Error(`missing chunk ${i}`);
    parts.push(c);
    size += c.length;
    received = size;
    onProgress?.(received);
  }
  if (size !== header.originalSize) {
    throw new Error(`size mismatch: expected ${header.originalSize} got ${size}`);
  }
  return new Blob(parts as BlobPart[]).arrayBuffer().then((b) => new Uint8Array(b));
}