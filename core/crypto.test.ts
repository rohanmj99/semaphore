import { beforeAll, describe, expect, it } from "vitest";
import {
  chunkNonce,
  cryptoAvailable,
  deriveKxSessionKey,
  derivePassphraseKey,
  fingerprint,
  initCrypto,
  keypair,
  openSeal,
  randomBytes,
  seal,
  wordPair,
} from "./crypto.ts";
import {
  arraySource,
  decryptChunk,
  encodeHeaderWire,
  ManifestBuilder,
  parseHeaderWire,
  reassemble,
  verifyWholeFile,
} from "./chunker.ts";
import { CIPHER_KX, CIPHER_PASSPHRASE } from "./types.ts";

describe("crypto", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("sealed box round-trips and fails with wrong key", async () => {
    const key = randomBytes(32);
    const wrong = randomBytes(32);
    const nonce = randomBytes(24);
    const plain = new TextEncoder().encode("attack at dawn");
    const ct = seal(key, nonce, plain);
    expect(openSeal(key, nonce, ct)).toEqual(plain);
    expect(openSeal(wrong, nonce, ct)).toBeNull();
    expect(openSeal(key, randomBytes(24), ct)).toBeNull();
  });

  it("key exchange derives a shared session key", () => {
    const a = keypair();
    const b = keypair();
    const ka = deriveKxSessionKey("sess-1", b.publicKey, a.secretKey);
    const kb = deriveKxSessionKey("sess-1", a.publicKey, b.secretKey);
    expect(ka.key).toEqual(kb.key);
    expect(fingerprint(a.publicKey)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("session binding prevents nonce reuse across sessions", () => {
    const a = keypair();
    const b = keypair();
    const k1 = deriveKxSessionKey("sess-1", b.publicKey, a.secretKey);
    const k2 = deriveKxSessionKey("sess-2", b.publicKey, a.secretKey);
    expect(k1.key).not.toEqual(k2.key);
    const n1 = chunkNonce(k1.key, "sess-1", 5);
    const n2 = chunkNonce(k2.key, "sess-2", 5);
    expect(n1).not.toEqual(n2);
  });

  it("passphrase mode derives deterministic keys", async () => {
    const k1 = await derivePassphraseKey("sess-9", "hunter2");
    const k2 = await derivePassphraseKey("sess-9", "hunter2");
    const k3 = await derivePassphraseKey("sess-9", "wrong");
    expect(k1.mode).toBe(CIPHER_PASSPHRASE);
    expect(k1.key).toEqual(k2.key);
    expect(k1.key).not.toEqual(k3.key);
  });

  it("word pairs are short and readable", () => {
    const w = wordPair(randomBytes(8));
    expect(w).toMatch(/^[a-z]+-[a-z]+$/);
    expect(w.length).toBeLessThanOrEqual(15);
  });

  it("cryptoAvailable flips after init", () => {
    expect(cryptoAvailable()).toBe(true);
  });
});

describe("chunking and wire format", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  const setup = async (size: number) => {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
    const source = arraySource(data, "sample.bin", "application/octet-stream");
    const kp = keypair();
    const sessionId = "test-session-1";
    const sessionKey = deriveKxSessionKey(sessionId, kp.publicKey, kp.secretKey).key;
    const builder = new ManifestBuilder(source, sessionId, sessionKey, 64);
    const header = await builder.buildHeader();
    return { data, builder, header, sessionKey, sessionId, kp };
  };

  it("0-byte file produces zero chunks and a valid header", async () => {
    const s = await setup(0);
    expect(s.header.totalChunks).toBe(0);
    expect(s.header.originalSize).toBe(0);
  });

  it("exact-multiple size is handled (no phantom chunk)", async () => {
    const s = await setup(128);
    expect(s.header.totalChunks).toBe(2);
    const ch = await s.builder.prepareChunk(1);
    const plain = decryptChunk(s.sessionKey, s.sessionId, 1, ch.ciphertext, ch.crc32);
    expect(plain).toEqual(s.data.subarray(64, 128));
  });

  it("chunk round-trip + crc verification", async () => {
    const s = await setup(1000);
    const ch = await s.builder.prepareChunk(7);
    const plain = decryptChunk(s.sessionKey, s.sessionId, 7, ch.ciphertext, ch.crc32);
    expect(plain).toEqual(s.data.subarray(7 * 64, 8 * 64));
    const bad = new Uint8Array(ch.ciphertext);
    bad[10] ^= 0xff;
    expect(decryptChunk(s.sessionKey, s.sessionId, 7, bad, ch.crc32)).toBeNull();
    expect(decryptChunk(s.sessionKey, s.sessionId, 7, ch.ciphertext, ch.crc32 ^ 1)).toBeNull();
    expect(decryptChunk(s.sessionKey, s.sessionId, 8, ch.ciphertext, ch.crc32)).toBeNull();
  });

  it("header wire round-trips and rejects session mismatch", async () => {
    const s = await setup(100);
    const wire = encodeHeaderWire(s.header, s.sessionKey);
    const ok = parseHeaderWire(wire, s.sessionKey, s.sessionId);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.header.crc32).toBe(s.header.crc32);
    const badKey = randomBytes(32);
    const failed = parseHeaderWire(wire, badKey, s.sessionId);
    expect(failed).toEqual({ ok: false, reason: "wrongKey", detail: "cannot open header" });
    const wrongSession = parseHeaderWire(wire, s.sessionKey, "other-session");
    expect(wrongSession).toEqual({ ok: false, reason: "wrongKey", detail: "session mismatch" });
  });

  it("rejects corrupted magic and version", async () => {
    const s = await setup(64);
    const wire = encodeHeaderWire(s.header, s.sessionKey);
    const bad = new Uint8Array(wire);
    bad[0] = 0x00;
    expect(parseHeaderWire(bad, s.sessionKey, s.sessionId).ok).toBe(false);
    const badVersion = new Uint8Array(wire);
    badVersion[2] = 0x09;
    expect(parseHeaderWire(badVersion, s.sessionKey, s.sessionId).ok).toBe(false);
  });

  it("reassembles the whole file and verifies crc", async () => {
    const s = await setup(1000);
    const map = new Map<number, Uint8Array>();
    for (let i = 0; i < s.header.totalChunks; i++) {
      const ch = await s.builder.prepareChunk(i);
      const plain = decryptChunk(s.sessionKey, s.sessionId, i, ch.ciphertext, ch.crc32);
      expect(plain).not.toBeNull();
      map.set(i, plain!);
    }
    const whole = await reassemble(map, s.header);
    expect(verifyWholeFile(whole, s.header)).toBe(true);
    expect(whole).toEqual(s.data);
    const truncated = new Uint8Array(whole);
    truncated[0] ^= 0x01;
    expect(verifyWholeFile(truncated, s.header)).toBe(false);
  });

  it("compressedSize reflects the compression attempt and crc32 matches", async () => {
    const data = new TextEncoder().encode("compressible payload ".repeat(500));
    const source = arraySource(data);
    const kp = keypair();
    const sessionKey = deriveKxSessionKey("s", kp.publicKey, kp.secretKey).key;
    const builder = new ManifestBuilder(source, "s", sessionKey, 256);
    const header = await builder.buildHeader();
    expect(header.compressedSize).toBeLessThan(header.originalSize);
    const { crc32 } = await import("./crc32.ts");
    expect(header.crc32).toBe(crc32(data));
  });
});

describe("cipher mode flags", () => {
  it("kx and passphrase modes are distinct", () => {
    expect(CIPHER_KX).not.toBe(CIPHER_PASSPHRASE);
  });
});