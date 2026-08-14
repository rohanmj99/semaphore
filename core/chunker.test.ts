import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto, deriveKxSessionKey, keypair } from "./crypto.ts";
import {
  ManifestBuilder,
  arraySource,
  decryptChunk,
  encodeHeaderWire,
  parseHeaderWire,
  reassemble,
  verifyWholeFile,
} from "./chunker.ts";

describe("chunker failure modes and edge sizes", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  function keys(sessionId = "chunk-tests") {
    const kp = keypair();
    const sessionKey = deriveKxSessionKey(sessionId, kp.publicKey, kp.secretKey).key;
    return { sessionId, sessionKey };
  }

  it("round-trips a header (encode → parse) with equal fields", async () => {
    const { sessionId, sessionKey } = keys();
    const builder = new ManifestBuilder(
      arraySource(new Uint8Array(700 * 1024), "big-ish-name.bin", "application/octet-stream"),
      sessionId,
      sessionKey,
    );
    const header = await builder.buildHeader();
    const wire = encodeHeaderWire(header, sessionKey);
    const res = parseHeaderWire(wire, sessionKey, sessionId);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.header).toEqual(header);
    }
  });

  it("rejects a header opened with the wrong key", async () => {
    const a = keys("sess-a");
    const b = keys("sess-b");
    const builder = new ManifestBuilder(arraySource(new Uint8Array(32), "x.bin"), a.sessionId, a.sessionKey);
    const header = await builder.buildHeader();
    const wire = encodeHeaderWire(header, a.sessionKey);
    expect(parseHeaderWire(wire, b.sessionKey, a.sessionId).ok).toBe(false);
    expect(parseHeaderWire(wire, b.sessionKey, a.sessionId)).toMatchObject({ reason: "wrongKey" });
  });

  it("rejects headers with bad magic or truncated payloads", async () => {
    const { sessionId, sessionKey } = keys();
    const builder = new ManifestBuilder(arraySource(new Uint8Array(16), "x.bin"), sessionId, sessionKey);
    const header = await builder.buildHeader();
    const wire = encodeHeaderWire(header, sessionKey);
    const truncated = wire.slice(0, wire.length - 3);
    wire[0] = 0x00;
    expect(parseHeaderWire(wire, sessionKey, sessionId)).toMatchObject({ reason: "badMagic" });
    expect(parseHeaderWire(new Uint8Array(10), sessionKey, sessionId)).toMatchObject({ reason: "badMagic" });
    expect(parseHeaderWire(truncated, sessionKey, sessionId)).toMatchObject({ reason: "malformed" });
  });

  it("0-byte files produce zero chunks", async () => {
    const { sessionId, sessionKey } = keys();
    const builder = new ManifestBuilder(arraySource(new Uint8Array(0), "empty.bin"), sessionId, sessionKey);
    const header = await builder.buildHeader();
    expect(header.totalChunks).toBe(0);
    expect(header.originalSize).toBe(0);
  });

  it("exact-multiple file size has no empty remainder chunk", async () => {
    const { sessionId, sessionKey } = keys();
    const chunkSize = 4096;
    const size = chunkSize * 3;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;
    const builder = new ManifestBuilder(arraySource(data, "exact.bin"), sessionId, sessionKey, chunkSize);
    const header = await builder.buildHeader();
    expect(header.totalChunks).toBe(3);
    for (let i = 0; i < 3; i++) {
      const { ciphertext, crc32 } = await builder.prepareChunk(i);
      const plain = decryptChunk(sessionKey, sessionId, i, ciphertext, crc32);
      expect(plain).not.toBeNull();
      expect(plain!.length).toBe(chunkSize);
      expect(plain).toEqual(data.subarray(i * chunkSize, (i + 1) * chunkSize));
    }
  });

  it("drops chunks whose per-chunk CRC or ciphertext is corrupted", async () => {
    const { sessionId, sessionKey } = keys();
    const data = new Uint8Array(3000).map((_, i) => (i * 31) & 0xff);
    const builder = new ManifestBuilder(arraySource(data, "crc.bin"), sessionId, sessionKey, 1024);
    const { ciphertext, crc32 } = await builder.prepareChunk(0);
    expect(decryptChunk(sessionKey, sessionId, 0, ciphertext, crc32)).toEqual(data.subarray(0, 1024));

    const wrongCrc = crc32 ^ 0xffffffff;
    expect(decryptChunk(sessionKey, sessionId, 0, ciphertext, wrongCrc)).toBeNull();

    const flipped = ciphertext.slice();
    flipped[flipped.length - 8] ^= 0xff;
    expect(decryptChunk(sessionKey, sessionId, 0, flipped, crc32)).toBeNull();
  });

  it("fails reassembly on missing chunks or size mismatch", async () => {
    const { sessionId, sessionKey } = keys();
    const data = new Uint8Array(3000).map((_, i) => (i * 31) & 0xff);
    const builder = new ManifestBuilder(arraySource(data, "re.bin"), sessionId, sessionKey, 1024);
    const header = await builder.buildHeader();
    const chunks = new Map<number, Uint8Array>();
    for (let i = 0; i < header.totalChunks; i++) {
      const { ciphertext, crc32 } = await builder.prepareChunk(i);
      chunks.set(i, decryptChunk(sessionKey, sessionId, i, ciphertext, crc32)!);
    }
    const full = await reassemble(chunks, header);
    expect(full).toEqual(data);
    expect(verifyWholeFile(full, header)).toBe(true);

    chunks.delete(1);
    await expect(reassemble(chunks, header)).rejects.toThrow(/missing chunk 1/);
  });

  it("verifies whole-file crc rejects tampered data", async () => {
    const { sessionId, sessionKey } = keys();
    const data = new Uint8Array(64).fill(7);
    const builder = new ManifestBuilder(arraySource(data, "tamper.bin"), sessionId, sessionKey, 32);
    const header = await builder.buildHeader();
    const bad = data.slice();
    bad[10] ^= 1;
    expect(verifyWholeFile(bad, header)).toBe(false);
  });

  it("sanitizes filenames (paths, control chars, dot-dot)", async () => {
    const { sessionId, sessionKey } = keys();
    const builder = new ManifestBuilder(
      arraySource(new Uint8Array(8), "../../etc/passwd\u0000\n☃.txt"),
      sessionId,
      sessionKey,
      8,
    );
    const header = await builder.buildHeader();
    expect(header.filename).not.toContain("/");
    expect(header.filename).not.toContain("..");
    expect(header.filename).toBeTruthy();
  });
});