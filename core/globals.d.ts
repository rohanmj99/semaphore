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
