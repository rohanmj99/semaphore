import sodium from "libsodium-wrappers";
import { CIPHER_KX, CIPHER_PASSPHRASE, FINGERPRINT_BYTES, type CipherMode } from "./types.ts";
import { concatB, hex, u32be } from "./util.ts";

let ready = false;

export async function initCrypto(): Promise<void> {
  if (ready) return;
  await sodium.ready;
  ready = true;
}

export function cryptoAvailable(): boolean {
  return ready;
}

export interface CryptoKeys {
  mode: CipherMode;
  sessionId: string;
  key: Uint8Array;
}

export function randomBytes(n: number): Uint8Array {
  return sodium.randombytes_buf(n);
}

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function keypair(): KeyPair {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export function fingerprint(pubKey: Uint8Array): string {
  return hex(sodium.crypto_generichash(FINGERPRINT_BYTES, pubKey));
}

export function createSessionId(): string {
  return hex(randomBytes(8));
}

const ADJECTIVES = [
  "amber", "azure", "bold", "calm", "crisp", "dull", "eager", "fair", "firm", "gloomy",
  "hale", "iced", "jade", "keen", "lax", "mild", "neat", "oily", "pale", "quiet",
  "rapid", "sharp", "taut", "vast", "warm", "yare",
];

const NOUNS = [
  "beacon", "cipher", "drift", "ember", "fjord", "grove", "halo", "inlet", "jetty",
  "kite", "lantern", "mast", "north", "osier", "pebble", "quartz", "reed", "sloop",
  "torch", "uplink", "vessel", "wharf", "yonder", "zephyr",
];

export function wordPair(bytes: Uint8Array): string {
  const h = sodium.crypto_generichash(2, bytes);
  return `${ADJECTIVES[h[0] % ADJECTIVES.length]}-${NOUNS[h[1] % NOUNS.length]}`;
}

const SALT_MAX = 32;

function saltFrom(sessionId: string): Uint8Array {
  const b = new TextEncoder().encode(sessionId);
  return b.length <= SALT_MAX ? b : b.slice(0, SALT_MAX);
}

/**
 * Passphrase mode key: PBKDF2-SHA256 (120k iterations) over the passphrase,
 * bound to the sessionId salt. (Argon2id is not available in libsodium.js
 * builds, so this is the memory-unity KDF we ship; v1 protocol.)
 */
export async function derivePassphraseKey(
  sessionId: string,
  passphrase: string,
): Promise<CryptoKeys> {
  const subtle =
    typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null;
  const base = saltFrom(sessionId);
  let key: Uint8Array;
  if (subtle) {
    const keyMaterial = await subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );
    const derived = await subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new Uint8Array(base),
        iterations: 120000,
        hash: "SHA-256",
      },
      keyMaterial,
      256,
    );
    key = new Uint8Array(derived);
  } else {
    // exotically constrained environments: iterate blake2b manually
    const pre = sodium.crypto_generichash(
      32,
      new TextEncoder().encode(passphrase),
      base,
    );
    key = pre;
    for (let i = 0; i < 1 << 16; i++) {
      key = sodium.crypto_generichash(32, key);
    }
  }
  return { mode: CIPHER_PASSPHRASE, sessionId, key };
}

export function deriveKxSessionKey(
  sessionId: string,
  peerPubKey: Uint8Array,
  ownSecretKey: Uint8Array,
): CryptoKeys {
  const shared = sodium.crypto_box_beforenm(peerPubKey, ownSecretKey);
  const key = sodium.crypto_generichash(32, concatB([shared, new TextEncoder().encode(sessionId)]));
  return { mode: CIPHER_KX, sessionId, key };
}

export function chunkNonce(sessionKey: Uint8Array, sessionId: string, index: number): Uint8Array {
  return sodium.crypto_generichash(
    24,
    concatB([new TextEncoder().encode(sessionId), u32be(index)]),
    sessionKey,
  );
}

export function sealedNonce(sessionKey: Uint8Array, label: string): Uint8Array {
  return sodium.crypto_generichash(24, new TextEncoder().encode(label), sessionKey);
}

export function seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  // XChaCha20-Poly1305 (AEAD, empty additional data) — key 32B, nonce 24B, +16B tag
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, key);
}

export function openSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array | null {
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key);
  } catch {
    return null;
  }
}

export function sha256Hash(bytes: Uint8Array): string {
  return hex(sodium.crypto_generichash(32, bytes));
}

export function sanitizeFilename(name: string): string {
  const replaced = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_");
  const cleaned = replaced.replace(/\.\./g, "_").trim();
  return cleaned || "file";
}