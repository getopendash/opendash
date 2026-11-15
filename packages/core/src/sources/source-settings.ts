/** What a person types into the connect form for a source, checked before anything is stored or queued. */
import { X509Certificate } from "node:crypto";
import type { DialectId, SourceConfig, SslMode } from "@opendash/connectors";

const SSL_MODES: SslMode[] = ["disable", "require", "verify-full"];

export type SettingsErrors = Partial<Record<keyof SourceConfig | "password", string>>;

/**
 * Per dialect: the usual port, the SSL default, and how long names may be. A new source verifies its server's
 * certificate unless its admin chooses otherwise: "require" encrypts without proving which server answered.
 */
const DEFAULTS: Record<DialectId, { port: number; sslMode: SslMode; maxName: number; label: string }> = {
  postgres: { port: 5432, sslMode: "verify-full", maxName: 63, label: "Postgres" },
  // HTTPS on 8443 with a verified certificate is how ClickHouse Cloud and most hosted ClickHouse are reached.
  clickhouse: { port: 8443, sslMode: "verify-full", maxName: 255, label: "ClickHouse" },
  mysql: { port: 3306, sslMode: "verify-full", maxName: 64, label: "MySQL" },
};

/** A pasted CA: a few certificates at most. */
const MAX_CA_LENGTH = 16 * 1024;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The CA certificates pasted (PEM), as Node reads them; null when they aren't certificates. */
function caCertificates(text: string): string | null {
  if (text.length > MAX_CA_LENGTH) return null;
  const pems = text.match(PEM_CERTIFICATE);
  if (!pems?.length || text.replace(PEM_CERTIFICATE, "").trim()) return null;
  try {
    for (const pem of pems) new X509Certificate(pem);
  } catch {
    return null;
  }
  return pems.join("\n");
}

export function parseSourceSettings(
  raw: Record<string, unknown>,
  dialect: DialectId = "postgres",
): { ok: true; config: SourceConfig } | { ok: false; errors: SettingsErrors } {
  const d = DEFAULTS[dialect];
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  const errors: SettingsErrors = {};
  const host = text("host");
  if (!host) errors.host = "Enter the host.";
  else if (host.length > 253 || /[\s/@?#]/.test(host) || host.includes("://")) {
    errors.host = "Enter a host name or IP address, without a scheme or path.";
  }
  const portText = text("port") || String(d.port);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65_535) errors.port = "Enter a port between 1 and 65535.";
  const database = text("database");
  if (!database) errors.database = "Enter the database name.";
  else if (database.length > d.maxName) errors.database = `${d.label} names are at most ${d.maxName} characters.`;
  const user = text("user");
  if (!user) errors.user = "Enter the user name.";
  else if (user.length > d.maxName) errors.user = `${d.label} names are at most ${d.maxName} characters.`;
  const sslMode = (text("sslMode") || d.sslMode) as SslMode;
  if (!SSL_MODES.includes(sslMode)) errors.sslMode = "Choose an SSL mode.";
  // Only verify-full uses a CA: with another mode a pasted one is dropped, never kept unused.
  const caText = sslMode === "verify-full" ? text("ca") : "";
  const ca = caText ? caCertificates(caText) : null;
  if (caText && !ca) errors.ca = "Paste the CA's certificate as PEM, from -----BEGIN CERTIFICATE----- to its END line.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, config: { host: host.toLowerCase(), port, database, user, sslMode, ...(ca ? { ca } : {}) } };
}

/** The connect form for Postgres (kept for its callers). */
export const parsePostgresSettings = (raw: Record<string, unknown>) => parseSourceSettings(raw, "postgres");
