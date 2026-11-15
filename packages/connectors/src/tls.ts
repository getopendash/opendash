/**
 * What a source's SSL mode means for its TLS, the same on every dialect:
 *   - verify-full: the certificate must chain to a trusted CA and name the host typed (even though the connection goes
 *     to the vetted address). The trusted CAs are the public ones, or only the CA its admin pasted when they did;
 *   - require: encrypted, not verified. Any certificate is accepted, so it doesn't prove which server answered;
 *   - disable: plain text, for a private network only.
 */
import type { PostgresConfig } from "./postgres/session";

export const verifies = (config: PostgresConfig) => config.sslMode === "verify-full";

/** The CA a verify-full source trusts instead of the public ones, when its admin gave one (PEM). */
export const trustedCa = (config: PostgresConfig) => (verifies(config) && config.ca ? config.ca : undefined);

/** What a certificate the server's TLS failed to verify means, and what to do (never: verify less). */
export const certificateAdvice = (config: PostgresConfig) =>
  `The server's TLS certificate couldn't be verified for ${config.host}. If your own CA signed it, paste that CA's certificate; otherwise fix the certificate.`;
