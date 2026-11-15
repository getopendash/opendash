/**
 * Secrets (Secrets). Each secret is AES-256-GCM under the org's data
 * key with AAD = org_id|secret_id|kind|key_version. Decrypted values live only in worker memory for the duration of
 * the work that needs them: never logged, never in prompts, never returned to clients.
 */
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import { NONCE_BYTES, open, seal } from "../crypto/aead";
import { dekAad, type Kek } from "../crypto/envelope";

export type SecretKind = "connection" | "oauth" | "llm_key" | "webhook" | "ssh" | "mcp";

const DEK_CACHE_MS = 5 * 60_000;

const secretAad = (orgId: string, id: string, kind: string, version: number) => `${orgId}|${id}|${kind}|${version}`;

export class SecretNotFound extends Error {
  override name = "SecretNotFound";
}

export interface SecretStore {
  put(tx: TenantTx, orgId: string, kind: SecretKind, plaintext: string): Promise<string>;
  /** Decrypts a secret of the expected kind. A secret of any other kind is "not found". */
  reveal(tx: TenantTx, orgId: string, id: string, kind: SecretKind): Promise<string>;
}

type DataKey = (tx: TenantTx, orgId: string, version?: number) => Promise<{ key: Uint8Array; version: number }>;

/** An organization's data key (its active one, or a given version), unwrapped by the KEK and cached for 5 minutes. */
function dataKeys(deps: { kek: Kek | (() => Kek); now?: () => number }): DataKey {
  const kek = () => (typeof deps.kek === "function" ? deps.kek() : deps.kek);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { key: Uint8Array; expires: number }>();

  return async function dataKey(tx, orgId, version) {
    const rows = await tx.execute<{ version: number; wrapped: string }>(
      version === undefined
        ? sql`select version, wrapped_dek as wrapped from app.org_key
              where org_id = ${orgId} and state = 'active' order by version desc limit 1`
        : sql`select version, wrapped_dek as wrapped from app.org_key
              where org_id = ${orgId} and version = ${version} and state <> 'destroyed'`,
    );
    const row = rows[0];
    if (!row)
      throw new SecretNotFound(version === undefined ? "No active data key for this org" : "Data key destroyed");
    const cacheKey = `${orgId}:${row.version}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > now()) return { key: hit.key, version: row.version };
    const key = await kek().unwrap(row.wrapped, dekAad(orgId, row.version));
    cache.set(cacheKey, { key, expires: now() + DEK_CACHE_MS });
    return { key, version: row.version };
  };
}

export function createSecretStore(deps: { kek: Kek | (() => Kek); now?: () => number }): SecretStore {
  const dataKey = dataKeys(deps);
  return {
    async put(tx, orgId, kind, plaintext) {
      const { key, version } = await dataKey(tx, orgId);
      const id = uuidv7();
      const { nonce, sealed: ciphertext } = seal(
        key,
        Buffer.from(plaintext, "utf8"),
        secretAad(orgId, id, kind, version),
      );
      await tx.execute(
        sql`insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
            values (${orgId}, ${id}, ${kind}, ${version}, ${nonce}, ${ciphertext})`,
      );
      return id;
    },

    async reveal(tx, orgId, id, kind) {
      const rows = await tx.execute<{ kind: string; key_version: number; nonce: Buffer; ciphertext: Buffer }>(
        sql`select kind, key_version, nonce, ciphertext from app.secret where org_id = ${orgId} and id = ${id}`,
      );
      const row = rows[0];
      if (!row || row.kind !== kind) throw new SecretNotFound("Secret not found");
      const { key } = await dataKey(tx, orgId, row.key_version);
      // The AAD uses the caller's org, id and kind, so a row edited to look like another kind still fails.
      return open(key, row.nonce, row.ciphertext, secretAad(orgId, id, kind, row.key_version)).toString("utf8");
    },
  };
}

/**
 * Seals values under an organization's data key for a store other than app.secret: single sign-on's provider settings
 * live in the auth schema, written by Better Auth. A sealed value carries its key version
 * (`odk1.<version>.<base64url nonce + ciphertext>`); its AAD binds it to the organization and the caller's context
 * (the row and field it belongs to), so a value moved to another row, field or organization fails to open.
 */
export interface OrgSealer {
  seal(orgId: string, context: string, plaintext: string): Promise<string>;
  /** Throws on anything that isn't a value this sealer made for that organization and context. */
  open(orgId: string, context: string, sealed: string): Promise<string>;
}

const SEALED_PREFIX = "odk1.";

export const isOrgSealed = (value: string): boolean => value.startsWith(SEALED_PREFIX);

export function createOrgSealer(deps: {
  kek: Kek | (() => Kek);
  /** A short transaction as the organization's tenant, to read its wrapped data key. */
  run: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  now?: () => number;
}): OrgSealer {
  const dataKey = dataKeys(deps);
  const aad = (orgId: string, context: string, version: number) => `org_sealed|${orgId}|${context}|${version}`;
  return {
    async seal(orgId, context, plaintext) {
      const { key, version } = await deps.run(orgId, (tx) => dataKey(tx, orgId));
      const { nonce, sealed } = seal(key, Buffer.from(plaintext, "utf8"), aad(orgId, context, version));
      return `${SEALED_PREFIX}${version}.${Buffer.concat([nonce, sealed]).toString("base64url")}`;
    },
    async open(orgId, context, value) {
      const match = /^odk1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(value);
      if (!match) throw new SecretNotFound("Not a sealed value");
      const version = Number(match[1]);
      const raw = Buffer.from(match[2] ?? "", "base64url");
      const { key } = await deps.run(orgId, (tx) => dataKey(tx, orgId, version));
      return open(key, raw.subarray(0, NONCE_BYTES), raw.subarray(NONCE_BYTES), aad(orgId, context, version)).toString(
        "utf8",
      );
    },
  };
}
