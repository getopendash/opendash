/**
 * Seals single sign-on provider secrets before Better Auth writes them, and opens them when it reads. `oidc_config` and
 * `saml_config` are JSON carrying the client secret and the SAML keys. The plugin reads and writes them as strings
 * through the database adapter, so the adapter is the one place that sees every read and write: wrapping it leaves the
 * plugin's routes untouched and makes "is this row sealed" a property of the table.
 *
 * Each value is sealed with the organization's data key, its AAD naming the provider and the field, so a value moved
 * to another row, field or organization fails to open. A provider without an organization, or a value in the clear,
 * fails closed: the provider is unusable, never silently empty.
 */
import { isOrgSealed, type OrgSealer } from "@opendash/core";
import type { DBAdapter, DBAdapterInstance, DBTransactionAdapter } from "better-auth";

export const SSO_PROVIDER_MODEL = "ssoProvider";
const SECRET_FIELDS = ["oidcConfig", "samlConfig"] as const;

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const touchesSecret = (value: unknown) => isRow(value) && SECRET_FIELDS.some((f) => typeof value[f] === "string");
const sealContext = (row: Row, field: string) => `sso_provider|${String(row.providerId ?? "")}|${field}`;

function identity(row: Row): { orgId: string; providerId: string } {
  const orgId = typeof row.organizationId === "string" ? row.organizationId : "";
  const providerId = typeof row.providerId === "string" ? row.providerId : "";
  if (!orgId || !providerId) {
    throw new Error("An SSO provider's settings can only be stored for an organization and a provider id");
  }
  return { orgId, providerId };
}

export function ssoSecretCodec(sealer: OrgSealer) {
  return {
    async seal(row: Row): Promise<Row> {
      const out = { ...row };
      for (const field of SECRET_FIELDS) {
        const value = out[field];
        if (typeof value !== "string" || !value || isOrgSealed(value)) continue;
        out[field] = await sealer.seal(identity(out).orgId, sealContext(out, field), value);
      }
      return out;
    },
    async open(row: Row): Promise<Row> {
      const out = { ...row };
      for (const field of SECRET_FIELDS) {
        const value = out[field];
        if (typeof value !== "string" || !value) continue;
        // The table was made with this codec in front of it: a value in the clear was written around it.
        if (!isOrgSealed(value)) throw new Error(`sso_provider.${field} is stored in the clear; refusing to use it`);
        out[field] = await sealer.open(identity(out).orgId, sealContext(out, field), value);
      }
      return out;
    },
  };
}

type Codec = ReturnType<typeof ssoSecretCodec>;
type CreateArgs = Parameters<DBTransactionAdapter["create"]>[0];
type UpdateArgs = Parameters<DBTransactionAdapter["update"]>[0];
type FindOneArgs = Parameters<DBTransactionAdapter["findOne"]>[0];
type FindManyArgs = Parameters<DBTransactionAdapter["findMany"]>[0];
type UpdateManyArgs = Parameters<DBTransactionAdapter["updateMany"]>[0];

function wrap<A extends DBTransactionAdapter>(adapter: A, codec: Codec): A {
  const isSso = (model: string) => model === SSO_PROVIDER_MODEL;
  const wrapped: DBTransactionAdapter = {
    ...adapter,
    async create(data: CreateArgs) {
      if (!isSso(data.model) || !isRow(data.data)) return adapter.create(data);
      const created = await adapter.create({ ...data, data: (await codec.seal(data.data)) as typeof data.data });
      return (isRow(created) ? await codec.open(created) : created) as never;
    },
    async update(data: UpdateArgs) {
      if (!isSso(data.model) || !touchesSecret(data.update)) {
        const updated = await adapter.update(data);
        return (isSso(data.model) && isRow(updated) ? await codec.open(updated) : updated) as never;
      }
      // The AAD needs the row's organization and provider id, which an update payload usually lacks: read them.
      const existing = await adapter.findOne<Row>({ model: data.model, where: data.where as never });
      if (!existing) return adapter.update(data);
      const update = data.update as Row;
      const sealed = await codec.seal({ ...existing, ...update });
      const changed = Object.fromEntries(Object.keys(update).map((k) => [k, sealed[k]]));
      const updated = await adapter.update({ ...data, update: changed as typeof data.update });
      return (isRow(updated) ? await codec.open(updated) : updated) as never;
    },
    async findOne(data: FindOneArgs) {
      const found = await adapter.findOne(data);
      return (isSso(data.model) && isRow(found) ? await codec.open(found) : found) as never;
    },
    async findMany(data: FindManyArgs) {
      const rows = await adapter.findMany(data);
      if (!isSso(data.model) || !Array.isArray(rows)) return rows;
      return (await Promise.all(rows.map((r) => (isRow(r) ? codec.open(r) : r)))) as never;
    },
    // A bulk write can't be sealed per row: refused rather than written in the clear. The plugin doesn't make one.
    async updateMany(data: UpdateManyArgs) {
      if (isSso(data.model) && touchesSecret(data.update)) {
        throw new Error("Refusing a bulk write of SSO provider settings: each row is sealed on its own");
      }
      return adapter.updateMany(data);
    },
  };
  return wrapped as A;
}

/** Wraps Better Auth's adapter, its transactions included, so no write of a provider's settings skips the seal. */
export function sealedSsoAdapter(factory: DBAdapterInstance, sealer: OrgSealer): DBAdapterInstance {
  const codec = ssoSecretCodec(sealer);
  return (options) => {
    const base = factory(options) as DBAdapter;
    const wrapped = wrap(base as unknown as DBTransactionAdapter, codec) as unknown as DBAdapter;
    return {
      ...wrapped,
      // Kept as is: the plugin checks it to know the adapter has real transactions (its user resolution needs them).
      options: base.options,
      transaction: <R>(callback: (trx: DBTransactionAdapter) => Promise<R>) =>
        base.transaction((trx) => callback(wrap(trx, codec))),
    } as DBAdapter;
  };
}
