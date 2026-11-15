/**
 * Envelope encryption (Secrets).
 * Each org has a data-encryption key (DEK). The DEK is stored only wrapped by a key-encryption key (KEK):
 * KMS in SaaS, OPENDASH_KEK in self-host. AES-256-GCM, with the org id and key version as associated data, so a
 * wrapped key moved to another org or version fails to unwrap.
 */
import { randomBytes } from "node:crypto";
import { NONCE_BYTES, open, seal, TAG_BYTES } from "./aead";

export interface Kek {
  /** Identifies the KEK (and its version) so a rotation can find what it wrapped. */
  readonly ref: string;
  wrap(dek: Uint8Array, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<Uint8Array>;
}

export const DEK_BYTES = 32;
const WRAPPED_BYTES = NONCE_BYTES + DEK_BYTES + TAG_BYTES;

export const generateDek = (): Uint8Array => new Uint8Array(randomBytes(DEK_BYTES));

/** Associated data that binds a wrapped DEK to its org and key version. */
export const dekAad = (orgId: string, version: number) => `org_key:${orgId}:${version}`;

/** A KEK held in process memory (self-host and development). Format: base64(iv | ciphertext | tag). */
export function localKek(base64Key: string, ref = "local:v1"): Kek {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("OPENDASH_KEK must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return {
    ref,
    async wrap(dek, aad) {
      if (dek.length !== DEK_BYTES) throw new Error("A data key must be 32 bytes");
      const { nonce, sealed } = seal(key, dek, aad);
      return Buffer.concat([nonce, sealed]).toString("base64");
    },
    async unwrap(wrapped, aad) {
      const raw = Buffer.from(wrapped, "base64");
      if (raw.length !== WRAPPED_BYTES) throw new Error("Wrapped data key has the wrong length");
      return new Uint8Array(open(key, raw.subarray(0, NONCE_BYTES), raw.subarray(NONCE_BYTES), aad));
    },
  };
}

/** The process KEK. SaaS swaps in a KMS-backed Kek with the same interface. */
export function kekFromEnv(): Kek {
  const value = process.env.OPENDASH_KEK;
  if (!value) throw new Error("OPENDASH_KEK is not set. Generate one with: openssl rand -base64 32");
  return localKek(value, process.env.OPENDASH_KEK_REF ?? "local:v1");
}
