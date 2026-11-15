/**
 * A workspace's AI providers and its default. Each provider is one row of its kind, its
 * credentials one secret of kind `llm_key` sealed as JSON (only the worker opens it, to test it and to run with it).
 * People see what `shownOf` keeps, whether its test passed, and the allowlisted models it offers. OpenDash, the
 * deployment's own, needs no row until an admin changes it: no row means it's on, with its measured models ticked.
 *
 * What a person can pick is, under each working provider, its ticked models that its own list still offers. The
 * default is one model on one provider at one level; when it can't run, the same model on another provider, then the
 * provider's first, then anyone's first. A provider that's being tested or isn't working offers nothing: OpenDash is
 * never used quietly in its place.
 */
import { type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { type AuditActor, audit } from "../audit/write";
import { enqueueOnce } from "../jobs/boss";
import { type AiProviderTestJob, aiProviderTestQueue } from "../jobs/queues";
import type { SecretStore } from "../secrets/store";
import {
  CATALOG,
  type CatalogModel,
  catalogModel,
  DEFAULT_MODEL,
  defaultLevelOf,
  isLevel,
  LEVELS,
  type Level,
  levelFor,
  levelsOf,
  type Maker,
} from "./catalog";
import {
  type CredentialField,
  type Credentials,
  checkCredentials,
  isProviderKind,
  KIND_ORDER,
  KINDS,
  type ProviderKind,
  shownOf,
} from "./kinds";
import type { Available } from "./match";

/** Which keys the deployment itself has (its environment), by name only: OpenDash's own provider runs on them. */
export interface DeploymentKeys {
  gateway: boolean;
  anthropic: boolean;
  openai: boolean;
  google: boolean;
}

/** The deployment's environment variable for each of OpenDash's own routes. */
export const DEPLOYMENT_ENV = {
  gateway: "AI_GATEWAY_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const;

export function deploymentKeys(env: NodeJS.ProcessEnv = process.env): DeploymentKeys {
  const has = (name: string) => Boolean(env[name]?.trim());
  return {
    gateway: has(DEPLOYMENT_ENV.gateway),
    anthropic: has(DEPLOYMENT_ENV.anthropic),
    openai: has(DEPLOYMENT_ENV.openai),
    google: has(DEPLOYMENT_ENV.google),
  };
}

/** How OpenDash's own calls go: through the deployment's gateway when it has a key for one, else each maker's key. */
export const openDashRoute = (d: DeploymentKeys): "gateway" | "direct" => (d.gateway ? "gateway" : "direct");

/**
 * What OpenDash's own provider can run: every allowlisted model through the deployment's gateway (by its gateway id),
 * else the models of each maker it has a key for (by their own ids).
 */
export function openDashAvailable(d: DeploymentKeys): Available {
  if (d.gateway) return Object.fromEntries(CATALOG.map((m) => [m.id, m.gateway]));
  return Object.fromEntries(CATALOG.filter((m) => d[m.maker]).map((m) => [m.id, m.id]));
}

export class AiProblem extends Error {
  constructor(
    readonly code: "invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

/** The model a run uses, the provider it runs on (by kind), and how long it thinks. */
export interface ModelChoice {
  model: string;
  provider: ProviderKind;
  reasoning: Level;
}

export type ProviderState = "not_set_up" | "testing" | "working" | "not_working" | "off";

/** An allowlisted model a provider offers, and whether people can pick it there. */
export interface PickableModel {
  id: string;
  label: string;
  blurb: string;
  maker: Maker;
  measured: CatalogModel["measured"];
  levels: Level[];
  /** Where it starts: its maker's default level. */
  defaultLevel: Level;
  picked: boolean;
}

export interface ProviderView {
  kind: ProviderKind;
  label: string;
  mono: string;
  group: (typeof KINDS)[ProviderKind]["group"];
  blurb: string;
  billing: string;
  billedTo: string;
  hint: string | null;
  fields: readonly CredentialField[];
  modes: readonly { id: string; label: string }[];
  state: ProviderState;
  /** Why it isn't working, in words a person can act on. */
  message: string | null;
  testedAt: string | null;
  listedAt: string | null;
  /** What Settings shows of its credentials. */
  shown: Record<string, string>;
  /** Its own list met with the allowlist; each says whether people can pick it. */
  models: PickableModel[];
  /** Allowed models of the makers it serves that its list doesn't have, by name ("Claude Fable 5.1"). */
  missing: string[];
  /** OpenDash only: whether its calls go through the deployment's gateway or each maker's key. */
  via: "gateway" | "direct" | null;
}

/** A test of credentials nobody has saved yet: what the provider can run, or why it can't. */
export interface ProviderTestView {
  id: string;
  kind: ProviderKind;
  state: "testing" | "ok" | "failed";
  message: string | null;
  /** What Settings will show of the credentials. */
  shown: Record<string, string>;
  /** What its list offers, the measured ones ticked. */
  models: PickableModel[];
  missing: string[];
}

/** A model a person can ask with, under the provider it runs on. */
export interface OfferedModel {
  id: string;
  label: string;
  blurb: string;
  maker: Maker;
  measured: CatalogModel["measured"];
  levels: Level[];
  /** Where it starts: its maker's default level. */
  defaultLevel: Level;
}

export interface OfferedGroup {
  provider: ProviderKind;
  label: string;
  /** Its name where room is short: "Bedrock". */
  short: string;
  mono: string;
  billing: string;
  /** Who's billed, and where its calls run when that's chosen: "Your AWS account · eu-central-1". */
  note: string;
  models: OfferedModel[];
}

export interface AiSettingsView {
  /** The thinking levels, in order, with what each means. */
  levels: { id: Level; label: string; blurb: string }[];
  providers: ProviderView[];
  /** What the composer's picker shows, by provider. */
  offered: OfferedGroup[];
  /**
   * The default, while something can run (null when nothing is offered): on the saved default's own provider while
   * that can run anything, another of its models if need be, as work nobody chose a model for gets it.
   */
  default: ModelChoice | null;
  /**
   * The saved default when it's held: on the workspace's own provider, which can run nothing now, so work
   * nobody chose a model for waits for it. Settings shows it with its provider marked, so changing only its thinking
   * keeps it there; the composer starts from `default` meanwhile.
   */
  held: { choice: ModelChoice; group: OfferedGroup } | null;
}

type ProviderRow = {
  kind: ProviderKind;
  secret_id: string | null;
  shown: Record<string, string>;
  status: "testing" | "ok" | "failed";
  message: string | null;
  tested_at: string | null;
  available: Available;
  listed_at: string | null;
  picked: string[] | null;
  enabled: boolean;
};

async function providerRows(tx: TenantTx, orgId: string): Promise<Map<ProviderKind, ProviderRow>> {
  const rows = await tx.execute<ProviderRow>(sql`
    select kind, secret_id, shown, status, message, tested_at, available, listed_at, picked, enabled
    from app.ai_provider where org_id = ${orgId}`);
  return new Map(rows.filter((r) => isProviderKind(r.kind)).map((r) => [r.kind, r]));
}

const iso = (t: string | null) => (t ? new Date(t).toISOString() : null);

/**
 * What a list offers people, as a dialog ticks it: `picked`, or (none chosen yet) the measured ones. A model OpenDash
 * hasn't measured with the analyst is listed, never ticked, whatever was stored (its tool loop isn't
 * verified on it), so nothing runs on it until it's measured.
 */
function pickable(available: Available, picked: readonly string[] | null): PickableModel[] {
  const offers = CATALOG.filter((m) => m.id in available);
  const ticked = new Set(picked ?? offers.map((m) => m.id));
  return offers.map((m) => ({
    id: m.id,
    label: m.label,
    blurb: m.blurb,
    maker: m.maker,
    measured: m.measured,
    levels: levelsOf(m.id),
    defaultLevel: defaultLevelOf(m.id),
    picked: ticked.has(m.id) && m.measured !== null,
  }));
}

/** Why a model can't be offered yet: OpenDash hasn't measured it with the analyst. */
const notMeasured = (label: string) =>
  new AiProblem("invalid", `${label} isn't measured yet: it can be offered once OpenDash has measured it.`);

/** The allowed models of the makers a kind serves that a list doesn't have. */
const missingFrom = (kind: ProviderKind, available: Available): string[] =>
  CATALOG.filter((m) => KINDS[kind].serves.includes(m.maker) && !(m.id in available)).map((m) => m.label);

/** A provider's state, what its list offers, and which of those people can pick. */
function providerView(kind: ProviderKind, row: ProviderRow | undefined, deployment: DeploymentKeys): ProviderView {
  const info = KINDS[kind];
  const opendash = kind === "opendash";
  const available = opendash ? openDashAvailable(deployment) : (row?.available ?? {});
  const models = pickable(available, row?.picked ?? null);
  let state: ProviderState;
  if (opendash) state = row && !row.enabled ? "off" : models.length ? "working" : "not_working";
  else if (!row) state = "not_set_up";
  else if (row.status === "testing") state = "testing";
  else if (row.status === "failed") state = "not_working";
  else state = row.enabled ? "working" : "off";
  const message =
    state !== "not_working"
      ? null
      : opendash
        ? "This server has no AI keys of its own."
        : (row?.message ?? "It isn't working. Test it again.");
  return {
    kind,
    label: info.label,
    mono: info.mono,
    group: info.group,
    blurb: info.blurb,
    billing: info.billing,
    billedTo: info.billedTo,
    hint: info.hint ?? null,
    fields: info.fields,
    modes: info.modes ?? [],
    state,
    message,
    testedAt: iso(row?.tested_at ?? null),
    listedAt: iso(row?.listed_at ?? null),
    shown: row?.shown ?? {},
    models,
    // Only a list that was read can say what it lacks; a provider not set up lacks nothing yet.
    missing: opendash || row?.listed_at ? missingFrom(kind, available) : [],
    via: opendash ? openDashRoute(deployment) : null,
  };
}

async function settingsRow(tx: TenantTx, orgId: string): Promise<ModelChoice | null> {
  const [row] = await tx.execute<{ default_model: string; default_provider: string; default_reasoning: string }>(sql`
    select default_model, default_provider, default_reasoning from app.ai_settings where org_id = ${orgId}`);
  if (!row || !isProviderKind(row.default_provider)) return null;
  return {
    model: row.default_model,
    provider: row.default_provider,
    reasoning: levelFor(row.default_model, row.default_reasoning),
  };
}

/** The workspace's chosen default, or OpenDash's: the model the analyst is measured on, at its default level. */
const chosenDefault = (row: ModelChoice | null): ModelChoice =>
  row ?? { model: DEFAULT_MODEL, provider: "opendash", reasoning: defaultLevelOf(DEFAULT_MODEL) };

/** The default while it can run; otherwise the same model elsewhere, the provider's first, then anyone's first. */
function effectiveDefault(chosen: ModelChoice, offered: OfferedGroup[]): ModelChoice | null {
  const on = (provider: ProviderKind) => offered.find((g) => g.provider === provider);
  const pick = (provider: ProviderKind, model: string): ModelChoice => ({
    model,
    provider,
    reasoning: levelFor(model, chosen.reasoning),
  });
  if (on(chosen.provider)?.models.some((m) => m.id === chosen.model)) return pick(chosen.provider, chosen.model);
  const elsewhere = offered.find((g) => g.models.some((m) => m.id === chosen.model));
  if (elsewhere) return pick(elsewhere.provider, chosen.model);
  const mine = on(chosen.provider)?.models[0];
  if (mine) return pick(chosen.provider, mine.id);
  const first = offered[0];
  return first?.models[0] ? pick(first.provider, first.models[0].id) : null;
}

/**
 * The default a run gets when nobody chose a model: the default while its provider can run it, else
 * another model that provider offers. A workspace's own provider that can run nothing holds its work instead: the run
 * fails saying so ("Amazon Bedrock isn't working"), and is never moved quietly to another provider, since a company's
 * own cloud is often where its data has to stay. Only OpenDash's own default gives way to what the workspace offers.
 */
function heldDefault(chosen: ModelChoice, offered: OfferedGroup[]): ModelChoice {
  if (chosen.provider === "opendash") return effectiveDefault(chosen, offered) ?? chosen;
  const own = offered.find((g) => g.provider === chosen.provider);
  const model = own?.models.find((m) => m.id === chosen.model) ?? own?.models[0];
  return model
    ? { model: model.id, provider: chosen.provider, reasoning: levelFor(model.id, chosen.reasoning) }
    : chosen;
}

export async function aiSettings(tx: TenantTx, orgId: string, deployment: DeploymentKeys): Promise<AiSettingsView> {
  const rows = await providerRows(tx, orgId);
  const providers = KIND_ORDER.map((kind) => providerView(kind, rows.get(kind), deployment));
  const offered: OfferedGroup[] = providers
    .filter((p) => p.state === "working")
    .map((p) => ({
      provider: p.kind,
      label: p.label,
      short: KINDS[p.kind].short,
      mono: p.mono,
      billing: p.billing,
      note:
        p.kind === "opendash"
          ? "Calls on OpenDash"
          : [p.billedTo, p.shown.region ?? p.shown.location].filter(Boolean).join(" · "),
      models: p.models.filter((m) => m.picked).map(({ picked: _picked, ...m }) => m),
    }))
    .filter((g) => g.models.length > 0);
  const saved = chosenDefault(await settingsRow(tx, orgId));
  const held = heldGroup(saved, offered, providers);
  return {
    levels: LEVELS.map((l) => ({ ...l })),
    providers,
    offered,
    // What everyone starts with is what work nobody chose for runs on (`heldDefault`): on its own provider while that
    // can run anything. Only a held default leaves the composer something else to start from, and Settings shows it.
    default: held || !offered.length ? effectiveDefault(saved, offered) : heldDefault(saved, offered),
    held,
  };
}

/** The saved default and its provider, as the picker shows a group, when it's held (`AiSettingsView.held`). */
function heldGroup(saved: ModelChoice, offered: OfferedGroup[], providers: ProviderView[]): AiSettingsView["held"] {
  if (saved.provider === "opendash" || offered.some((g) => g.provider === saved.provider)) return null;
  const p = providers.find((x) => x.kind === saved.provider);
  const m = catalogModel(saved.model);
  if (!p || !m) return null;
  return {
    choice: saved,
    group: {
      provider: p.kind,
      label: p.label,
      short: KINDS[p.kind].short,
      mono: p.mono,
      billing: p.billing,
      note: p.state === "not_set_up" ? "Not set up" : "Not working",
      models: [
        {
          id: m.id,
          label: m.label,
          blurb: m.blurb,
          maker: m.maker,
          measured: m.measured,
          levels: levelsOf(m.id),
          defaultLevel: defaultLevelOf(m.id),
        },
      ],
    },
  };
}

/** What the composer's picker shows. */
export interface OfferedModels {
  levels: AiSettingsView["levels"];
  offered: OfferedGroup[];
  default: ModelChoice | null;
  /** The providers set up that aren't working, by name: what an admin is told under the models. */
  notWorking: string[];
}

/** What a person can ask with in the composer: the offered models by provider, the levels, and the default. */
export async function offeredModels(tx: TenantTx, orgId: string, deployment: DeploymentKeys): Promise<OfferedModels> {
  const s = await aiSettings(tx, orgId, deployment);
  return {
    levels: s.levels,
    offered: s.offered,
    default: s.default,
    // OpenDash without keys is the server's to fix, not the workspace's.
    notWorking: s.providers.filter((p) => p.state === "not_working" && p.kind !== "opendash").map((p) => p.label),
  };
}

/**
 * What a run gets when nobody chose (background work, evals, Slack, the API): the default held to its provider
 * (`heldDefault`). With nothing it can run, it's the chosen default all the same, and its run says what's missing.
 */
export async function defaultChoice(
  tx: TenantTx,
  orgId: string,
  deployment: DeploymentKeys = deploymentKeys(),
): Promise<ModelChoice> {
  const s = await aiSettings(tx, orgId, deployment);
  return heldDefault(chosenDefault(await settingsRow(tx, orgId)), s.offered);
}

/** What a person may ask for: a model, the provider it runs on, and a level, each optional. */
export interface Chosen {
  model?: string | undefined;
  provider?: string | undefined;
  reasoning?: string | undefined;
}

/**
 * The model, provider and level a question runs on: what the person chose, if it's offered; with no model chosen,
 * the default held to its provider (`heldDefault`: Slack and the API may name none; the composer always sends what
 * its picker shows), at the level they chose if they chose one. A model named without its provider runs on the
 * default's provider when that offers it, else on the first that does: naming a model is choosing. A level the model
 * doesn't take is Auto. Throws AiProblem for a model or provider that isn't on offer.
 */
export async function choiceForQuestion(
  tx: TenantTx,
  orgId: string,
  deployment: DeploymentKeys,
  chosen: Chosen | undefined,
): Promise<ModelChoice> {
  const s = await aiSettings(tx, orgId, deployment);
  const saved = chosenDefault(await settingsRow(tx, orgId));
  // No model chosen: the default, held to its provider.
  if (!chosen?.model) {
    const held = heldDefault(saved, s.offered);
    return { ...held, reasoning: levelFor(held.model, chosen?.reasoning ?? held.reasoning) };
  }
  // A model chosen: it runs where it's offered, the default's provider (as the composer shows it) first.
  const fallback = s.default ?? saved;
  const level = (model: string, same: boolean) =>
    levelFor(model, chosen.reasoning ?? (same ? fallback.reasoning : undefined));
  const model = chosen.model;
  const provider = chosen.provider;
  // Choosing the default is never worse than choosing nothing (its run says what's missing, if anything is).
  if (model === fallback.model && (provider === undefined || provider === fallback.provider)) {
    return { ...fallback, reasoning: level(model, true) };
  }
  const groups = s.offered.filter((g) => g.models.some((m) => m.id === model));
  const on =
    provider === undefined
      ? (groups.find((g) => g.provider === fallback.provider) ?? groups[0])
      : groups.find((g) => g.provider === provider);
  if (!on) {
    throw new AiProblem("invalid", "That model isn't offered here. Choose another, or ask an admin to offer it.");
  }
  return { model, provider: on.provider, reasoning: level(model, false) };
}

/** `actor`: who the audit log names (an API key when the call came with one); else the user. */
type Ctx = { orgId: string; userId: string | null; actor?: AuditActor };
const actorOf = (ctx: Ctx): AuditActor | undefined =>
  ctx.actor ?? (ctx.userId ? { type: "user", id: ctx.userId } : undefined);

const known = (kind: unknown): ProviderKind => {
  if (!isProviderKind(kind)) throw new AiProblem("invalid", "That provider isn't supported.");
  return kind;
};

/**
 * Each test makes the worker call a provider with credentials someone typed. Owners and admins only, and bounded per
 * workspace; tests nobody saved lose their sealed credentials after a day (a secret a provider uses is kept).
 */
export const PROVIDER_TEST_LIMIT = { max: 20, window: "10 minutes" } as const;
const UNUSED_TEST_RETENTION = "1 day";

async function deleteUnusedTestSecrets(tx: TenantTx, orgId: string) {
  await tx.execute(sql`
    delete from app.secret s using app.ai_provider_test t
    where t.org_id = ${orgId} and s.org_id = t.org_id and s.id = t.secret_id and t.used_at is null
      and t.created_at < now() - ${UNUSED_TEST_RETENTION}::interval
      and not exists (select 1 from app.ai_provider p where p.org_id = s.org_id and p.secret_id = s.id)`);
}

/**
 * Owners and admins: a provider's credentials as typed, tested before anything is saved. They're checked
 * and sealed at once; the worker reads what the provider can run and asks it once. Nothing about the workspace's
 * providers changes until Set up (saveProvider) takes the test. Returns the test's id.
 */
export async function requestProviderTest(
  deps: { secrets: Pick<SecretStore, "put">; boss: PgBoss },
  tx: TenantTx,
  ctx: Ctx,
  input: { kind: string; credentials: unknown },
): Promise<string> {
  const kind = known(input.kind);
  if (kind === "opendash") throw new AiProblem("invalid", "OpenDash needs nothing set up.");
  const checked = checkCredentials(kind, input.credentials);
  if (!checked.ok) throw new AiProblem("invalid", checked.message);
  // A row lock on the workspace, held only for this short transaction, so tests are counted one after another.
  await tx.execute(sql`select 1 from app.org where id = ${ctx.orgId} for update`);
  const [recent] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.ai_provider_test
    where org_id = ${ctx.orgId} and created_at > now() - ${PROVIDER_TEST_LIMIT.window}::interval`);
  if ((recent?.n ?? 0) >= PROVIDER_TEST_LIMIT.max) {
    throw new AiProblem("invalid", "Too many tests in a short time. Wait a few minutes and try again.");
  }
  await deleteUnusedTestSecrets(tx, ctx.orgId);
  const secretId = await deps.secrets.put(tx, ctx.orgId, "llm_key", JSON.stringify(checked.credentials));
  const testId = uuidv7();
  await tx.execute(sql`
    insert into app.ai_provider_test (org_id, id, kind, secret_id, shown, requested_by)
    values (${ctx.orgId}, ${testId}, ${kind}, ${secretId},
      ${JSON.stringify(shownOf(kind, checked.credentials as Credentials))}::jsonb, ${ctx.userId})`);
  const job: AiProviderTestJob = { orgId: ctx.orgId, kind, secretId, testId };
  await enqueueOnce(deps.boss, tx, aiProviderTestQueue, job, { singletonKey: `${ctx.orgId}:${secretId}` });
  return testId;
}

type TestRow = {
  id: string;
  kind: ProviderKind;
  secret_id: string;
  shown: Record<string, string>;
  status: "testing" | "ok" | "failed";
  message: string | null;
  available: Available;
  used_at: string | null;
  created_at: string;
};

async function testRow(tx: TenantTx, orgId: string, testId: string): Promise<TestRow | null> {
  const [row] = await tx.execute<TestRow>(sql`
    select id, kind, secret_id, shown, status, message, available, used_at, created_at
    from app.ai_provider_test where org_id = ${orgId} and id = ${testId}`);
  return row && isProviderKind(row.kind) ? row : null;
}

/** Owners and admins: a test's result, while the dialog waits on it. */
export async function providerTest(tx: TenantTx, orgId: string, testId: string): Promise<ProviderTestView> {
  const row = await testRow(tx, orgId, testId);
  if (!row) throw new AiProblem("not_found", "That test doesn't exist.");
  const available = row.status === "ok" ? row.available : {};
  return {
    id: row.id,
    kind: row.kind,
    state: row.status,
    message: row.message,
    shown: row.shown,
    models: pickable(available, null),
    missing: row.status === "ok" ? missingFrom(row.kind, available) : [],
  };
}

/**
 * Owners and admins: Set up (or Save, on a provider being replaced) from a test that passed. The provider takes the
 * test's sealed credentials and what its list offered, with the models ticked; the credentials it had are deleted.
 * A test is used once, and only within a day.
 */
export async function saveProvider(
  tx: TenantTx,
  ctx: Ctx,
  input: { kind: string; testId: string; picked: string[] },
): Promise<void> {
  const kind = known(input.kind);
  const test = await testRow(tx, ctx.orgId, input.testId);
  if (!test || test.kind !== kind || test.used_at) throw new AiProblem("not_found", "That test doesn't exist.");
  if (Date.now() - new Date(test.created_at).getTime() > 24 * 3600_000) {
    throw new AiProblem("invalid", "That test is too old. Test the connection again.");
  }
  if (test.status !== "ok") throw new AiProblem("invalid", "Test the connection first: it has to work to be set up.");
  const picked = [...new Set(input.picked)];
  for (const id of picked) {
    const m = catalogModel(id);
    if (!m || !(id in test.available)) {
      throw new AiProblem("invalid", `${KINDS[kind].label} doesn't offer ${m?.label ?? id}.`);
    }
    if (!m.measured) throw notMeasured(m.label);
  }
  const [previous] = await tx.execute<{ secret_id: string | null }>(sql`
    select secret_id from app.ai_provider where org_id = ${ctx.orgId} and kind = ${kind} for update`);
  await tx.execute(sql`
    insert into app.ai_provider (org_id, id, kind, secret_id, shown, status, tested_at, available, listed_at, picked,
      created_by)
    values (${ctx.orgId}, ${uuidv7()}, ${kind}, ${test.secret_id}, ${JSON.stringify(test.shown)}::jsonb, 'ok', now(),
      ${JSON.stringify(test.available)}::jsonb, now(), ${JSON.stringify(picked)}::jsonb, ${ctx.userId})
    on conflict (org_id, kind) do update set secret_id = excluded.secret_id, shown = excluded.shown, status = 'ok',
      message = null, tested_at = now(), available = excluded.available, listed_at = now(), picked = excluded.picked,
      enabled = true, updated_at = now()`);
  await tx.execute(sql`
    update app.ai_provider_test set used_at = now() where org_id = ${ctx.orgId} and id = ${test.id}`);
  if (previous?.secret_id && previous.secret_id !== test.secret_id) {
    await tx.execute(sql`delete from app.secret where org_id = ${ctx.orgId} and id = ${previous.secret_id}`);
  }
  await audit(tx, {
    action: previous ? "ai_connection.updated" : "ai_connection.created",
    actor: actorOf(ctx),
    target: { type: "ai_connection", name: KINDS[kind].label },
    fields: previous ? ["credentials", "models"] : [],
    detail: { kind },
  });
}

/** Owners and admins: removes a provider and its sealed credentials. OpenDash can be turned off, not removed. */
export async function removeProvider(
  tx: TenantTx,
  ctx: { orgId: string; actor?: AuditActor },
  kind: string,
): Promise<void> {
  const k = known(kind);
  if (k === "opendash") throw new AiProblem("invalid", "OpenDash can be turned off, not removed.");
  const [row] = await tx.execute<{ secret_id: string | null }>(sql`
    delete from app.ai_provider where org_id = ${ctx.orgId} and kind = ${k} returning secret_id`);
  if (!row) throw new AiProblem("not_found", "That provider isn't set up.");
  if (row.secret_id)
    await tx.execute(sql`delete from app.secret where org_id = ${ctx.orgId} and id = ${row.secret_id}`);
  await audit(tx, {
    action: "ai_connection.deleted",
    actor: ctx.actor,
    target: { type: "ai_connection", name: KINDS[k].label },
    detail: { kind: k },
  });
}

/** Owners and admins: tests a provider's credentials again, and reads what it can run. */
export async function retestProvider(deps: { boss: PgBoss }, tx: TenantTx, ctx: { orgId: string }, kind: string) {
  const k = known(kind);
  const [row] = await tx.execute<{ secret_id: string | null }>(sql`
    update app.ai_provider set status = 'testing', message = null, updated_at = now()
    where org_id = ${ctx.orgId} and kind = ${k} and secret_id is not null returning secret_id`);
  if (!row?.secret_id) throw new AiProblem("not_found", "That provider isn't set up.");
  const job: AiProviderTestJob = { orgId: ctx.orgId, kind: k, secretId: row.secret_id };
  await enqueueOnce(deps.boss, tx, aiProviderTestQueue, job, {
    singletonKey: `${ctx.orgId}:${row.secret_id}:${Date.now()}`,
  });
}

/**
 * Owners and admins: which of a provider's models people can pick, and (OpenDash) whether it's on. Only models its
 * own list offers can be ticked.
 */
export async function setProviderModels(
  tx: TenantTx,
  ctx: Ctx,
  deployment: DeploymentKeys,
  input: { kind: string; picked: string[]; enabled?: boolean },
): Promise<void> {
  const kind = known(input.kind);
  const picked = [...new Set(input.picked)];
  const rows = await providerRows(tx, ctx.orgId);
  const row = rows.get(kind);
  if (kind !== "opendash" && !row) throw new AiProblem("not_found", "That provider isn't set up.");
  const view = providerView(kind, row, deployment);
  for (const id of picked) {
    const m = catalogModel(id);
    if (!m) throw new AiProblem("invalid", `${id} isn't a model OpenDash allows.`);
    if (!view.models.some((x) => x.id === id)) {
      throw new AiProblem("invalid", `${view.label} doesn't offer ${m.label}.`);
    }
    if (!m.measured) throw notMeasured(m.label);
  }
  const enabled = input.enabled ?? row?.enabled ?? true;
  if (kind === "opendash") {
    await tx.execute(sql`
      insert into app.ai_provider (org_id, id, kind, status, picked, enabled, created_by)
      values (${ctx.orgId}, ${uuidv7()}, 'opendash', 'ok', ${JSON.stringify(picked)}::jsonb, ${enabled}, ${ctx.userId})
      on conflict (org_id, kind) do update set picked = excluded.picked, enabled = excluded.enabled,
        updated_at = now()`);
    return;
  }
  await tx.execute(sql`
    update app.ai_provider set picked = ${JSON.stringify(picked)}::jsonb, enabled = ${enabled}, updated_at = now()
    where org_id = ${ctx.orgId} and kind = ${kind}`);
}

/** Owners and admins: the default model, the provider it runs on, and its level. It has to be on offer. */
export async function setDefaultModel(
  tx: TenantTx,
  ctx: Ctx,
  deployment: DeploymentKeys,
  input: { model: string; provider: string; reasoning: string },
): Promise<ModelChoice> {
  const s = await aiSettings(tx, ctx.orgId, deployment);
  const group = s.offered.find((g) => g.provider === input.provider);
  // A held default keeps its place when only its thinking changes; moving it takes a model people can pick.
  const same = s.held?.choice.model === input.model && s.held.choice.provider === input.provider;
  if (!same && !group?.models.some((m) => m.id === input.model)) {
    throw new AiProblem("invalid", "The default has to be a model people can pick.");
  }
  const choice: ModelChoice = {
    model: input.model,
    provider: same && s.held ? s.held.choice.provider : (group as OfferedGroup).provider,
    reasoning: levelFor(input.model, input.reasoning),
  };
  await tx.execute(sql`
    insert into app.ai_settings (org_id, default_model, default_provider, default_reasoning, updated_by, updated_at)
    values (${ctx.orgId}, ${choice.model}, ${choice.provider}, ${choice.reasoning}, ${ctx.userId}, now())
    on conflict (org_id) do update set default_model = excluded.default_model,
      default_provider = excluded.default_provider, default_reasoning = excluded.default_reasoning,
      updated_by = excluded.updated_by, updated_at = now()`);
  return choice;
}

/** What a provider's test found: what it can run, or why it can't, and whether the provider refused the credentials. */
export type ProviderTestResult = { ok: true; available: Available } | { ok: false; message: string; refused: boolean };

type WithTenant = <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

/** A provider's credentials, opened (the worker only). */
async function revealed(
  deps: { secrets: SecretStore },
  tx: TenantTx,
  orgId: string,
  secretId: string,
): Promise<Credentials> {
  return JSON.parse(await deps.secrets.reveal(tx, orgId, secretId, "llm_key")) as Credentials;
}

/**
 * The worker's side of a test: opens the credentials (only here), has the provider say what it can run, and records
 * it, on the test (credentials not saved yet) or on the provider (Test again, and the daily refresh). A provider
 * whose credentials were replaced since the job was queued isn't touched. A daily refresh (`job.refresh`) only
 * updates the list: a provider that refuses the credentials then stops working, but one that can't be reached keeps
 * working on what it listed last.
 */
export async function testProvider(
  deps: { withTenant: WithTenant; secrets: SecretStore },
  job: AiProviderTestJob,
  check: (kind: ProviderKind, credentials: Credentials, options: { refresh: boolean }) => Promise<ProviderTestResult>,
): Promise<ProviderTestResult | null> {
  const credentials = await deps.withTenant(job.orgId, async (tx) => {
    const [row] = job.testId
      ? await tx.execute(sql`
          select 1 from app.ai_provider_test where org_id = ${job.orgId} and id = ${job.testId}
            and secret_id = ${job.secretId} and status = 'testing'`)
      : await tx.execute(sql`
          select 1 from app.ai_provider where org_id = ${job.orgId} and kind = ${job.kind}
            and secret_id = ${job.secretId}`);
    return row ? revealed(deps, tx, job.orgId, job.secretId) : null;
  });
  if (credentials === null) return null;
  const result = await check(job.kind, credentials, { refresh: job.refresh === true }).catch(
    (): ProviderTestResult => ({ ok: false, message: "The test couldn't run. Test it again.", refused: false }),
  );
  await deps.withTenant(job.orgId, async (tx) => {
    if (job.testId) {
      await tx.execute(sql`
        update app.ai_provider_test set status = ${result.ok ? "ok" : "failed"},
          message = ${result.ok ? null : result.message},
          available = ${JSON.stringify(result.ok ? result.available : {})}::jsonb, finished_at = now()
        where org_id = ${job.orgId} and id = ${job.testId} and status = 'testing'`);
      return;
    }
    const same = sql`org_id = ${job.orgId} and kind = ${job.kind} and secret_id = ${job.secretId}`;
    if (result.ok) {
      await tx.execute(sql`
        update app.ai_provider set status = 'ok', message = null, tested_at = now(),
          available = ${JSON.stringify(result.available)}::jsonb, listed_at = now(), updated_at = now()
        where ${same} ${job.refresh ? sql`and status = 'ok'` : sql``}`);
    } else if (!job.refresh || result.refused) {
      await tx.execute(sql`
        update app.ai_provider set status = 'failed', message = ${result.message}, tested_at = now(),
          updated_at = now()
        where ${same}`);
    }
  });
  return result;
}

/** A test that died (dead-lettered): failed, saying so, so neither a test nor a provider is left testing for ever. */
export async function failProviderTest(deps: { withTenant: WithTenant }, job: AiProviderTestJob): Promise<void> {
  await deps.withTenant(job.orgId, (tx) =>
    job.testId
      ? tx.execute(sql`
          update app.ai_provider_test set status = 'failed', message = 'The test didn''t finish. Test it again.',
            finished_at = now()
          where org_id = ${job.orgId} and id = ${job.testId} and status = 'testing'`)
      : tx.execute(sql`
          update app.ai_provider set status = 'failed', message = 'The test didn''t finish. Test it again.',
            tested_at = now(), updated_at = now()
          where org_id = ${job.orgId} and kind = ${job.kind} and secret_id = ${job.secretId} and status = 'testing'`),
  );
}

/**
 * Once a day, every working provider with a list of its own reads it again, so a model its provider
 * stops offering drops out by itself. Vertex is probed only when tested, so as not to spend on a workspace's bill.
 */
export async function dispatchProviderRefresh(deps: {
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  withTenant: WithTenant;
  boss: PgBoss;
  now?: () => Date;
}): Promise<{ queued: number }> {
  const listed = KIND_ORDER.filter((k) => KINDS[k].models === "list");
  const rows = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; kind: ProviderKind; secret_id: string }>(sql`
      select org_id, kind, secret_id from app.ai_provider
      where status = 'ok' and secret_id is not null and kind in (${sql.join(
        listed.map((k) => sql`${k}`),
        sql`, `,
      )})`),
  );
  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  let queued = 0;
  for (const r of rows) {
    const job: AiProviderTestJob = { orgId: r.org_id, kind: r.kind, secretId: r.secret_id, refresh: true };
    const id = await deps.withTenant(r.org_id, (tx) =>
      enqueueOnce(deps.boss, tx, aiProviderTestQueue, job, { singletonKey: `${r.org_id}:${r.secret_id}:${day}` }),
    );
    if (id) queued += 1;
  }
  return { queued };
}

/** What the worker builds a run's model from: a provider's state, its list, what's ticked, and its credentials. */
export interface RunProvider {
  kind: ProviderKind;
  label: string;
  state: ProviderState;
  /** Allowlisted model id → the id to call it by. */
  available: Available;
  picked: string[];
  /** Opened in the worker; null for OpenDash, whose keys are the deployment's. */
  credentials: Credentials | null;
}

/** The worker's resolver: a provider as a run sees it, its credentials opened (only here). */
export async function providerForRun(
  deps: { secrets: SecretStore },
  tx: TenantTx,
  orgId: string,
  kind: ProviderKind,
  deployment: DeploymentKeys,
): Promise<RunProvider> {
  const rows = await providerRows(tx, orgId);
  const row = rows.get(kind);
  const view = providerView(kind, row, deployment);
  const available = kind === "opendash" ? openDashAvailable(deployment) : (row?.available ?? {});
  return {
    kind,
    label: view.label,
    state: view.state,
    available,
    picked: view.models.filter((m) => m.picked).map((m) => m.id),
    credentials:
      kind !== "opendash" && row?.secret_id && view.state === "working"
        ? await revealed(deps, tx, orgId, row.secret_id)
        : null,
  };
}

/** The provider an organization's embeddings use: its own OpenAI key when it works, else none of its own. */
export async function openAiKeyFor(
  deps: { secrets: SecretStore },
  tx: TenantTx,
  orgId: string,
): Promise<{ apiKey: string } | { failed: true } | null> {
  const [row] = await tx.execute<{ secret_id: string | null; status: string; enabled: boolean }>(sql`
    select secret_id, status, enabled from app.ai_provider where org_id = ${orgId} and kind = 'openai'`);
  if (!row?.secret_id) return null;
  if (row.status !== "ok" || !row.enabled) return { failed: true };
  return { apiKey: ((await revealed(deps, tx, orgId, row.secret_id)) as Credentials<"openai">).apiKey };
}
