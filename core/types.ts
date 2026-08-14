export const MAGIC = "AB";
export const PROTO_VERSION = 1;
export const CIPHER_KX = 1;
export const CIPHER_PASSPHRASE = 2;

export const CHUNK_CRC_SIZE = 4;
export const SECRETBOX_TAG = 16;
export const SECRETBOX_NONCE = 24;
export const FINGERPRINT_BYTES = 6;

export type CipherMode = 1 | 2;

export interface ManifestHeader {
  magic: string;
  version: number;
  cipher: CipherMode;
  filename: string;
  mime: string;
  originalSize: number;
  compressedSize: number;
  crc32: number;
  totalChunks: number;
  chunkSize: number;
  senderFingerprint: string;
  sessionId: string;
  passphraseFingerprint?: string;
}

export interface TransferMeta {
  filename: string;
  mime: string;
  originalSize: number;
  compressedSize: number;
  crc32: number;
  totalChunks: number;
  chunkSize: number;
}

export type ChunkStatus = "missing" | "received" | "bad";

export interface ChunkFrame {
  sessionId: string;
  index: number;
  ciphertext: Uint8Array;
  crc32: number;
}

export interface ProgressStats {
  transferredBytes: number;
  totalBytes: number;
  chunksDelivered: number;
  totalChunks: number;
  errors: number;
  retries: number;
  elapsedMs: number;
  etaMs: number | null;
  kbps: number;
  phase: TransferPhase;
}

export type TransferPhase =
  | "manifest"
  | "running"
  | "repair"
  | "verifying"
  | "done"
  | "aborted"
  | "connecting"
  | "reconnecting";

export type ChannelKind = "loopback" | "light" | "sound" | "online";