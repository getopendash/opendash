/**
 * AES-256-GCM with a random 96-bit nonce and a full 128-bit tag. Node accepts truncated tags unless authTagLength
 * is pinned (DEP0182), so both directions pin it and every input length is checked before use.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new Error("AES-256-GCM needs a 32-byte key");
}

/** Returns the nonce and `ciphertext | tag`. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): { nonce: Buffer; sealed: Buffer } {
  checkKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  return { nonce, sealed: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]) };
}

/** Throws unless `sealed` is a ciphertext plus its full tag, made with this key, nonce and associated data. */
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  checkKey(key);
  if (nonce.length !== NONCE_BYTES) throw new Error("AES-256-GCM nonce must be 12 bytes");
  if (sealed.length < TAG_BYTES) throw new Error("Ciphertext is shorter than its authentication tag");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
}
