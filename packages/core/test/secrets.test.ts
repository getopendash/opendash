import { randomBytes } from "node:crypto";
import { uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seal } from "../src/crypto/aead";
import { dekAad, generateDek, localKek } from "../src/crypto/envelope";
import { createSecretStore } from "../src/secrets/store";

let t: TestDatabase;
const kek = localKek(randomBytes(32).toString("base64"));
const orgA = uuidv7();
const orgB = uuidv7();
const store = createSecretStore({ kek });

async function orgWithKey(id: string) {
  await createOrg(t, id, `Org ${id.slice(-4)}`);
  const wrapped = await kek.wrap(generateDek(), dekAad(id, 1));
  await t.system
    .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${id}, 1, ${wrapped}, ${kek.ref})`;
}

beforeAll(async () => {
  t = await freshDatabase();
  await orgWithKey(orgA);
  await orgWithKey(orgB);
});

afterAll(async () => {
  await t?.drop();
});

describe("secret store", () => {
  it("round-trips a secret and stores only ciphertext", async () => {
    const id = await withTenantOn(t.app, { orgId: orgA }, (tx) => store.put(tx, orgA, "connection", "s3cr3t-password"));
    const value = await withTenantOn(t.app, { orgId: orgA }, (tx) => store.reveal(tx, orgA, id, "connection"));
    expect(value).toBe("s3cr3t-password");
    const [raw] = await t.owner<{ c: Buffer }[]>`select ciphertext as c from app.secret where id = ${id}`;
    expect(raw?.c.toString("utf8")).not.toContain("s3cr3t");
  });

  it("another org can't read it, even by id", async () => {
    const id = await withTenantOn(t.app, { orgId: orgA }, (tx) => store.put(tx, orgA, "connection", "a-only"));
    await expect(
      withTenantOn(t.app, { orgId: orgB }, (tx) => store.reveal(tx, orgB, id, "connection")),
    ).rejects.toThrow(/not found/);
  });

  it("a ciphertext copied to another row fails to decrypt (AAD binds it to its id and kind)", async () => {
    const id = await withTenantOn(t.app, { orgId: orgA }, (tx) => store.put(tx, orgA, "connection", "bound"));
    const forged = uuidv7();
    await t.owner`
      insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
      select org_id, ${forged}, kind, key_version, nonce, ciphertext from app.secret where id = ${id}`;
    await expect(
      withTenantOn(t.app, { orgId: orgA }, (tx) => store.reveal(tx, orgA, forged, "connection")),
    ).rejects.toThrow();
  });

  it("a secret can't be revealed as another kind", async () => {
    const id = await withTenantOn(t.app, { orgId: orgA }, (tx) => store.put(tx, orgA, "llm_key", "sk-a"));
    await expect(
      withTenantOn(t.app, { orgId: orgA }, (tx) => store.reveal(tx, orgA, id, "connection")),
    ).rejects.toThrow(/not found/);
    // Relabelling the row doesn't help: the AAD carries the kind the caller asked for.
    await t.owner`update app.secret set kind = 'connection' where id = ${id}`;
    await expect(
      withTenantOn(t.app, { orgId: orgA }, (tx) => store.reveal(tx, orgA, id, "connection")),
    ).rejects.toThrow();
  });

  it("a ciphertext cut down to a truncated tag is refused (tags are always 16 bytes)", async () => {
    // Node accepts short GCM tags unless authTagLength is pinned. This is the input a lax decoder accepts:
    // an empty plaintext stored with only the first 4 bytes of its tag.
    const [k] = await t.owner<{ wrapped: string }[]>`
      select wrapped_dek as wrapped from app.org_key where org_id = ${orgA} and version = 1`;
    const dek = await kek.unwrap(k?.wrapped ?? "", dekAad(orgA, 1));
    const id = uuidv7();
    const { nonce, sealed } = seal(dek, new Uint8Array(), `${orgA}|${id}|connection|1`);
    await t.owner`
      insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
      values (${orgA}, ${id}, 'connection', 1, ${nonce}, ${sealed.subarray(0, 4)})`;
    await expect(
      withTenantOn(t.app, { orgId: orgA }, (tx) => store.reveal(tx, orgA, id, "connection")),
    ).rejects.toThrow(/shorter than its authentication tag/);
  });

  it("destroying the org's key makes its secrets unrecoverable, even with the key cached (crypto-shredding)", async () => {
    const id = await withTenantOn(t.app, { orgId: orgB }, (tx) => store.put(tx, orgB, "llm_key", "sk-test"));
    // The reveal warms this store's data-key cache; shredding must still win.
    await expect(withTenantOn(t.app, { orgId: orgB }, (tx) => store.reveal(tx, orgB, id, "llm_key"))).resolves.toBe(
      "sk-test",
    );
    await t.owner`update app.org_key set state = 'destroyed', wrapped_dek = '' where org_id = ${orgB}`;
    await expect(withTenantOn(t.app, { orgId: orgB }, (tx) => store.reveal(tx, orgB, id, "llm_key"))).rejects.toThrow(
      /destroyed/,
    );
  });
});
