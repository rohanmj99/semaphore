declare module "libsodium-wrappers" {
  const sodium: {
    ready: Promise<void>;
    randombytes_buf(n: number): Uint8Array;
    crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string };
    crypto_box_beforenm(pub: Uint8Array, sec: Uint8Array): Uint8Array;
    crypto_generichash(
      outlen: number,
      input: Uint8Array,
      key?: Uint8Array | null,
    ): Uint8Array;
    crypto_secretbox_xchacha20poly1305_easy(
      plaintext: Uint8Array,
      nonce: Uint8Array,
      key: Uint8Array,
    ): Uint8Array;
    crypto_secretbox_xchacha20poly1305_open_easy(
      ciphertext: Uint8Array,
      nonce: Uint8Array,
      key: Uint8Array,
    ): Uint8Array | null;
    crypto_aead_xchacha20poly1305_ietf_encrypt(
      message: Uint8Array,
      additionalData: Uint8Array | null,
      secretNonce: Uint8Array | null,
      publicNonce: Uint8Array,
      key: Uint8Array,
    ): Uint8Array;
    crypto_aead_xchacha20poly1305_ietf_decrypt(
      secretNonce: Uint8Array | null,
      ciphertext: Uint8Array,
      additionalData: Uint8Array | null,
      publicNonce: Uint8Array,
      key: Uint8Array,
    ): Uint8Array;
    crypto_pwhash(
      outlen: number,
      passwd: string,
      salt: Uint8Array,
      opslimit: number,
      memlimit: number,
      alg: number,
      outputFormat?: string,
    ): Uint8Array;
    crypto_pwhash_OPSLIMIT_MODERATE: number;
    crypto_pwhash_MEMLIMIT_MODERATE: number;
    crypto_pwhash_ALG_ARGON2ID13: number;
  };
  export default sodium;
}

declare module "jsqr" {
  interface QRCodeCoordinate {
    x: number;
    y: number;
  }
  interface QRCode {
    binaryData: number[];
    data: string;
    chunks: Array<{ type: number; text: string }>;
    version: number;
    location: {
      topRightCorner: QRCodeCoordinate;
      topLeftCorner: QRCodeCoordinate;
      bottomRightCorner: QRCodeCoordinate;
      bottomLeftCorner: QRCodeCoordinate;
      topRightFinderPattern: QRCodeCoordinate;
      topLeftFinderPattern: QRCodeCoordinate;
      bottomLeftFinderPattern: QRCodeCoordinate;
      bottomRightFinderPattern: QRCodeCoordinate;
    };
  }
  function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    providedOptions?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
  ): QRCode | null;
  export default jsQR;
}

declare module "qrcode/lib/core/qrcode" {
  interface QrBitMatrix {
    size: number;
    data: Uint8Array;
  }
  interface QrCreateOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    version?: number;
    maskPattern?: number;
    toSJISFunc?: (codePoint: string) => number;
  }
  const QRCode: {
    create(
      data: string | Array<{ data: string | Uint8Array; mode?: string }>,
      options?: QrCreateOptions,
    ): { modules: QrBitMatrix; version: number };
  };
  export default QRCode;
}
