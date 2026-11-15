/**
 * The router: the contract's procedures, each a thin handler over @opendash/core. One middleware resolves
 * the tenant (a session or API key, with the membership check) before input is validated, so a caller without access
 * learns nothing about the input; every database access then goes through withTenant inside core.
 */

import {
  AiProblem,
  AttachmentProblem,
  aiSettings,
  approveLearning,
  askableSources,
  attachable,
  ContextProblem,
  callDetail,
  choiceForQuestion,
  chooseLearnedTables,
  type DeploymentKeys,
  dashboards,
  EvalProblem,
  editLearning,
  evalOverview,
  evalRunDetail,
  getQueryCard,
  getRun,
  getSource,
  getThread,
  giveFeedback,
  LearningProblem,
  learningChoice,
  learningsForRun,
  listLearnings,
  listThreadPage,
  logger,
  mcp,
  myFeedback,
  NotFound,
  NotYours,
  offeredModels,
  ProjectNotFound,
  ProjectRefused,
  ProposalProblem,
  providerTest,
  REVERT_SUPERSEDED,
  RunActive,
  readReference,
  recentRuns,
  rejectLearning,
  removeProvider,
  requestMetricDraft,
  requestProviderTest,
  requestRecords,
  requestSourceDrafts,
  requestStop,
  retestProvider,
  revertLearning,
  runEvents,
  type SecretStore,
  SpendLimitProblem,
  SpendLimitReached,
  saveProvider,
  setDashboardStar,
  setDefaultModel,
  setNightlyEvals,
  setProviderModels,
  setSpendLimits,
  setThreadStar,
  shareThread,
  sourceReadiness,
  spendView,
  startEvalRun,
  submitQuestion,
  suggestedQuestions,
  suggestLearning,
  type ThreadSummary,
  takeBackFollowUp,
  traceFor,
  track,
  withdrawFeedback,
} from "@opendash/core";
import { type TenantTx, uuidv7 } from "@opendash/db";
import { implement } from "@orpc/server";
import type { PgBoss } from "pg-boss";
import { contract, type ThreadListing } from "./contract";

export interface ApiTenant {
  orgId: string;
  /** Null for an organization API key. */
  userId: string | null;
  /** Where the call came from: the web UI (a session) or the API (a key). */
  channel: "web" | "api";
  /** The member's role; none for an organization key, which acts as the organization. */
  role?: string;
  /** The API key the call came with, for the audit log (channel "api"). */
  keyId?: string | null;
}

export interface ApiDeps {
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** A transaction that carries the caller too: what's theirs alone (a memory) is written in one. */
  withUser?: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /**
   * Who is calling, from the request's headers: null when signed out; throws when signed in without access to the
   * organization (the caller maps both to errors).
   */
  resolveTenant: (headers: Headers) => Promise<ApiTenant | null>;
  /** The job queue's producer, for queuing runs. */
  boss: () => Promise<PgBoss>;
  /** Which model providers the deployment has a key for (its environment). */
  deploymentKeys: DeploymentKeys;
  /** Encrypts an organization's model keys (never decrypts them: only the worker does). */
  secrets?: Pick<SecretStore, "put">;
  /** Names of the organization's members by user id (from the auth side); others' conversations show who started them. */
  authors?: (orgId: string, userIds: string[]) => Promise<Record<string, string>>;
  /**
   * Everyone in the workspace, by name: who a record's work can be given to, and (with their address and role) who a
   * dashboard can be shared with.
   */
  people?: (orgId: string) => Promise<{ id: string; name: string; email?: string; role?: string }[]>;
  /** The signed link that opens a dashboard's frame on the frames origin; absent when frames aren't set up here. */
  frameUrl?: (input: { bundleHash: string | null; title: string }) => string | null;
  /** MCP connections: what reaching servers and keeping their accounts needs; absent: not set up here. */
  mcp?: mcp.McpDeps;
}

export interface ApiContext {
  headers: Headers;
  /** The call's reference (handler.ts): on its answer's header, and on the log line if it breaks. */
  requestId?: string;
  /**
   * Who the call turned out to be from, noted once they're resolved, for the handler's log line when a call fails
   * (handler.ts): the context a procedure gets isn't the one its caller holds.
   */
  seen?: { orgId?: string; userId?: string | null };
}

export function createRouter(deps: ApiDeps) {
  const os = implement(contract).$context<ApiContext & { tenant?: ApiTenant }>();

  const requireTenant = os.middleware(async ({ context, next, errors }) => {
    // v2 doesn't dedupe middleware: a context that already has the tenant passes straight through.
    if (context.tenant) return next({ context: { tenant: context.tenant } });
    let tenant: ApiTenant | null;
    try {
      tenant = await deps.resolveTenant(context.headers);
    } catch {
      throw errors.FORBIDDEN();
    }
    if (!tenant) throw errors.UNAUTHORIZED();
    if (context.seen) Object.assign(context.seen, { orgId: tenant.orgId, userId: tenant.userId });
    return next({ context: { tenant } });
  });

  const authed = os.use(requireTenant);
  const viewer = (t: ApiTenant) => ({ orgId: t.orgId, userId: t.userId });
  /** Who the audit log names for a call: its API key, or the signed-in person. */
  const actor = (t: ApiTenant) =>
    t.channel === "api" && t.keyId
      ? { type: "api_key" as const, id: t.keyId }
      : t.userId
        ? { type: "user" as const, id: t.userId }
        : undefined;
  /** Adds who started each conversation someone else started. */
  const withAuthors = async (orgId: string, threads: ThreadSummary[]): Promise<ThreadListing[]> => {
    const others = [...new Set(threads.filter((x) => !x.mine && x.createdBy).map((x) => x.createdBy as string))];
    const names = others.length && deps.authors ? await deps.authors(orgId, others) : {};
    return threads.map((x) => ({ ...x, author: !x.mine && x.createdBy ? (names[x.createdBy] ?? null) : null }));
  };

  /** When each person last read references (a minute's worth), for readReference's limit. */
  const readsBy = new Map<string, number[]>();

  /** Names people by their ids (who started a run, who owns something). */
  const ownerNames = async (orgId: string, ownerIds: (string | null)[]): Promise<Record<string, string>> => {
    const ids = [...new Set(ownerIds.filter((x): x is string => !!x))];
    return ids.length && deps.authors ? deps.authors(orgId, ids) : {};
  };
  /**
   * Who may build or change dashboards: a person (owner_id is who may change it; an organization key has no person,
   * and two keys would share ownership), and not a viewer, who reads shared dashboards.
   */
  const builds = (t: ApiTenant, errors: { FORBIDDEN: (o?: { message?: string }) => Error }) => {
    if (!t.userId) throw errors.FORBIDDEN({ message: "Dashboards belong to a person: use a user API key." });
    if (t.role === "viewer") {
      throw errors.FORBIDDEN({ message: "Viewers read shared dashboards; they don't build them." });
    }
  };

  /** Owners and admins: they run the workspace (its background work, Activity). */
  const manages = (t: ApiTenant) => t.role === "owner" || t.role === "admin";
  /** Owners and admins only: evals (they read every case's answer and spend model calls), AI models and keys. */
  const admins = (
    t: ApiTenant,
    errors: { FORBIDDEN: (o?: { message?: string }) => Error },
    message = "Evals are for the organization's owners and admins.",
  ) => {
    if (!manages(t)) throw errors.FORBIDDEN({ message });
  };
  /** Runs an AI settings call and turns its problems into the contract's errors. */
  const aiCall = async <T>(
    errors: { NOT_FOUND?: (o?: { message?: string }) => Error; INVALID?: (o?: { message?: string }) => Error },
    fn: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof AiProblem)) throw error;
      if (error.code === "invalid" && errors.INVALID) throw errors.INVALID({ message: error.message });
      if (errors.NOT_FOUND) throw errors.NOT_FOUND({ message: error.message });
      throw error;
    }
  };
  const withRequesters = async <R extends { requestedBy: string | null }>(orgId: string, runs: R[]) => {
    const names = await ownerNames(
      orgId,
      runs.map((r) => r.requestedBy),
    );
    return runs.map((r) => ({ ...r, requester: r.requestedBy ? (names[r.requestedBy] ?? null) : null }));
  };

  /** Runs a dashboards call and turns its problems into the contract's errors. */
  const dashboardCall = async <T>(
    errors: {
      NOT_FOUND: (o?: { message?: string }) => Error;
      INVALID?: (o?: { message?: string }) => Error;
      FORBIDDEN: (o?: { message?: string }) => Error;
    },
    fn: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof dashboards.DashboardProblem)) throw error;
      if (error.code === "not_yours") throw errors.FORBIDDEN({ message: error.message });
      if (error.code === "not_found" || !errors.INVALID) throw errors.NOT_FOUND({ message: error.message });
      throw errors.INVALID({ message: error.message });
    }
  };
  /** A dashboard is changed by a person (its owner), never an organization key. */
  const person = (t: ApiTenant, errors: { FORBIDDEN: (o?: { message?: string }) => Error }): string => {
    if (!t.userId) throw errors.FORBIDDEN({ message: "Dashboards belong to a person: use a user API key." });
    return t.userId;
  };

  /**
   * Runs an MCP call as the signed-in person and turns its problems into the contract's errors. MCP acts as a person
   * (their own account, or as an admin): an organization API key can't use it.
   */
  const mcpCall = async <T>(
    t: ApiTenant,
    errors: {
      NOT_FOUND?: (o?: { message?: string }) => Error;
      INVALID: (o?: { message?: string }) => Error;
      FORBIDDEN: (o?: { message?: string }) => Error;
    },
    fn: (deps: mcp.McpDeps, actor: { orgId: string; userId: string }) => Promise<T>,
  ): Promise<T> => {
    if (!deps.mcp) throw errors.INVALID({ message: "Connections aren't set up on this server." });
    if (!t.userId) throw errors.FORBIDDEN({ message: "Connections belong to a person: use a user API key." });
    try {
      return await fn(deps.mcp, { orgId: t.orgId, userId: t.userId });
    } catch (error) {
      if (!(error instanceof mcp.McpProblem)) throw error;
      if (error.code === "forbidden") throw errors.FORBIDDEN({ message: error.message });
      if (error.code === "not_found" && errors.NOT_FOUND) throw errors.NOT_FOUND({ message: error.message });
      throw errors.INVALID({ message: error.message });
    }
  };

  return os.router({
    mcp: {
      servers: authed.mcp.servers.handler(({ context, errors }) =>
        mcpCall(context.tenant, errors, (d, a) => mcp.listServers(d, a)),
      ),
      server: authed.mcp.server.handler(({ context, input, errors }) =>
        mcpCall(context.tenant, errors, (d, a) => mcp.serverDetail(d, a, input.serverId)),
      ),
      detect: authed.mcp.detect.handler(({ context, input, errors }) =>
        mcpCall(context.tenant, errors, (d, a) => mcp.detectServer(d, a, input)),
      ),
      approve: authed.mcp.approve.handler(({ context, input, errors }) =>
        mcpCall(context.tenant, errors, (d, a) =>
          mcp.approveServer(d, a, {
            ...input,
            client: input.client ? { ...input.client, clientSecret: input.client.clientSecret ?? null } : null,
          }),
        ),
      ),
      update: authed.mcp.update.handler(async ({ context, input, errors }) => {
        const { serverId, client, ...patch } = input;
        await mcpCall(context.tenant, errors, (d, a) =>
          mcp.updateServer(d, a, serverId, {
            ...patch,
            ...(client !== undefined
              ? { client: client ? { ...client, clientSecret: client.clientSecret ?? null } : null }
              : {}),
          }),
        );
        return { ok: true as const };
      }),
      remove: authed.mcp.remove.handler(async ({ context, input, errors }) => {
        await mcpCall(context.tenant, errors, (d, a) => mcp.removeServer(d, a, input.serverId));
        return { ok: true as const };
      }),
      listTools: authed.mcp.listTools.handler(({ context, input, errors }) =>
        mcpCall(context.tenant, errors, (d, a) => mcp.listServerTools(d, a, input.serverId)),
      ),
      setTool: authed.mcp.setTool.handler(async ({ context, input, errors }) => {
        const { serverId, name, ...patch } = input;
        await mcpCall(context.tenant, errors, (d, a) => mcp.updateTool(d, a, serverId, name, patch));
        return { ok: true as const };
      }),
      mine: authed.mcp.mine.handler(({ context, errors }) =>
        mcpCall(context.tenant, errors, (d, a) => mcp.myConnections(d, a)),
      ),
      connect: authed.mcp.connect.handler(({ context, input, errors }) =>
        mcpCall(context.tenant, errors, (d, a) => mcp.startConnect(d, a, input)),
      ),
      disconnect: authed.mcp.disconnect.handler(async ({ context, input, errors }) => ({
        removed: await mcpCall(context.tenant, errors, (d, a) => mcp.disconnect(d, a, input)),
      })),
      putKey: authed.mcp.putKey.handler(({ context, input, errors }) =>
        mcpCall(context.tenant, errors, (d, a) => mcp.putKey(d, a, input)),
      ),
    },
    usage: {
      limits: authed.usage.limits.handler(({ context, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Spend limits are for the organization's owners and admins.");
        return deps.withTenant(t.orgId, (tx) => spendView(tx, t.orgId));
      }),
      setLimits: authed.usage.setLimits.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Spend limits are set by the organization's owners and admins.");
        try {
          return await deps.withTenant(t.orgId, async (tx) => {
            await setSpendLimits(tx, { orgId: t.orgId, userId: t.userId, actor: actor(t) }, input);
            return spendView(tx, t.orgId);
          });
        } catch (error) {
          if (error instanceof SpendLimitProblem) throw errors.INVALID({ message: error.message });
          throw error;
        }
      }),
    },
    ai: {
      models: authed.ai.models.handler(async ({ context }) => {
        const t = context.tenant;
        const { notWorking, ...o } = await deps.withTenant(t.orgId, (tx) =>
          offeredModels(tx, t.orgId, deps.deploymentKeys),
        );
        // Only those who can fix a provider are told one isn't working.
        return { ...o, manage: manages(t) ? { notWorking } : null };
      }),
      settings: authed.ai.settings.handler(({ context, errors }) => {
        const t = context.tenant;
        admins(t, errors, "AI is set up by the organization's owners and admins.");
        return deps.withTenant(t.orgId, (tx) => aiSettings(tx, t.orgId, deps.deploymentKeys));
      }),
      testProvider: authed.ai.testProvider.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Providers are set up by the organization's owners and admins.");
        if (!deps.secrets) throw new Error("Testing a provider needs the secret store.");
        const secrets = deps.secrets;
        const boss = await deps.boss();
        const testId = await aiCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            requestProviderTest({ secrets, boss }, tx, { orgId: t.orgId, userId: t.userId }, input),
          ),
        );
        return { testId };
      }),
      providerTest: authed.ai.providerTest.handler(({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Providers are set up by the organization's owners and admins.");
        return aiCall(errors, () => deps.withTenant(t.orgId, (tx) => providerTest(tx, t.orgId, input.testId)));
      }),
      saveProvider: authed.ai.saveProvider.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Providers are set up by the organization's owners and admins.");
        await aiCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            saveProvider(tx, { orgId: t.orgId, userId: t.userId, actor: actor(t) }, input),
          ),
        );
        return { ok: true as const };
      }),
      removeProvider: authed.ai.removeProvider.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Providers are removed by the organization's owners and admins.");
        await aiCall(errors, () =>
          deps.withTenant(t.orgId, (tx) => removeProvider(tx, { orgId: t.orgId, actor: actor(t) }, input.kind)),
        );
        return { ok: true as const };
      }),
      retestProvider: authed.ai.retestProvider.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Providers are tested by the organization's owners and admins.");
        const boss = await deps.boss();
        await aiCall(errors, () =>
          deps.withTenant(t.orgId, (tx) => retestProvider({ boss }, tx, { orgId: t.orgId }, input.kind)),
        );
        return { ok: true as const };
      }),
      setProviderModels: authed.ai.setProviderModels.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "AI models are set by the organization's owners and admins.");
        await aiCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            setProviderModels(tx, { orgId: t.orgId, userId: t.userId }, deps.deploymentKeys, input),
          ),
        );
        return { ok: true as const };
      }),
      setDefault: authed.ai.setDefault.handler(({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "The default model is set by the organization's owners and admins.");
        return aiCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            setDefaultModel(tx, { orgId: t.orgId, userId: t.userId }, deps.deploymentKeys, input),
          ),
        );
      }),
    },
    proposals: {
      request: authed.proposals.request.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        builds(t, errors);
        if (!t.userId) throw errors.FORBIDDEN({ message: "A draft is asked by a person: use a user API key." });
        try {
          return await requestMetricDraft(
            { withTenant: deps.withTenant, boss: await deps.boss(), deploymentKeys: deps.deploymentKeys },
            { orgId: t.orgId, userId: t.userId },
            input,
          );
        } catch (error) {
          if (!(error instanceof ProposalProblem)) throw error;
          throw error.code === "not_found"
            ? errors.NOT_FOUND({ message: error.message })
            : errors.INVALID({ message: error.message });
        }
      }),
      draftSource: authed.proposals.draftSource.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Owners and admins draft a source's definitions.");
        if (!t.userId) throw errors.FORBIDDEN({ message: "A draft is asked by a person: use a user API key." });
        try {
          return await requestSourceDrafts(
            { withTenant: deps.withTenant, boss: await deps.boss(), deploymentKeys: deps.deploymentKeys },
            { orgId: t.orgId, userId: t.userId },
            input,
          );
        } catch (error) {
          if (!(error instanceof ProposalProblem)) throw error;
          throw error.code === "not_found"
            ? errors.NOT_FOUND({ message: error.message })
            : errors.INVALID({ message: error.message });
        }
      }),
    },
    evals: {
      overview: authed.evals.overview.handler(async ({ context, errors }) => {
        const t = context.tenant;
        admins(t, errors);
        const overview = await deps.withTenant(t.orgId, (tx) => evalOverview(tx, t.orgId));
        return { ...overview, runs: await withRequesters(t.orgId, overview.runs) };
      }),
      run: authed.evals.run.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors);
        const run = await deps.withTenant(t.orgId, (tx) => evalRunDetail(tx, t.orgId, input.evalRunId));
        if (!run) throw errors.NOT_FOUND();
        const [named] = await withRequesters(t.orgId, [run]);
        return named as typeof run & { requester: string | null };
      }),
      start: authed.evals.start.handler(async ({ context, errors }) => {
        const t = context.tenant;
        admins(t, errors);
        const boss = await deps.boss();
        try {
          return await startEvalRun(
            { withTenant: deps.withTenant, boss },
            { orgId: t.orgId, userId: t.userId, trigger: "manual" },
          );
        } catch (error) {
          if (error instanceof EvalProblem && error.code === "busy")
            throw errors.RUN_ACTIVE({ message: error.message });
          if (error instanceof SpendLimitReached) throw errors.SPEND_LIMIT({ message: error.message });
          throw error;
        }
      }),
      setNightly: authed.evals.setNightly.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors);
        await deps.withTenant(t.orgId, (tx) => setNightlyEvals(tx, t.orgId, input.nightly));
        return { nightly: input.nightly };
      }),
    },
    dashboards: {
      list: authed.dashboards.list.handler(async ({ context, input }) => {
        const t = context.tenant;
        const list = await deps.withTenant(t.orgId, (tx) =>
          dashboards.listDashboards(tx, viewer(t), input?.threadId ? { threadId: input.threadId } : {}),
        );
        const names = await ownerNames(
          t.orgId,
          list.filter((d) => !d.mine).map((d) => d.ownerId),
        );
        return list.map((d) => ({ ...d, owner: d.mine ? null : (names[d.ownerId] ?? null) }));
      }),
      get: authed.dashboards.get.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const d = await deps.withTenant(t.orgId, (tx) => dashboards.getDashboard(tx, viewer(t), input.dashboardId));
        if (!d) throw errors.NOT_FOUND();
        const names = d.mine ? {} : await ownerNames(t.orgId, [d.ownerId]);
        const link = (bundleHash: string | null) => deps.frameUrl?.({ bundleHash, title: d.title }) ?? null;
        return {
          ...d,
          owner: d.mine ? null : (names[d.ownerId] ?? null),
          frameUrl: d.version ? link(d.version.bundleHash) : null,
          draftFrameUrl: d.draft?.revision ? link(d.draft.bundleHash) : null,
        };
      }),
      query: authed.dashboards.query.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const boss = await deps.boss();
        // As the person: a service a dashboard reads is their own account, which row security shows to them alone.
        const userId = viewer(t).userId;
        const tenant = <T>(fn: (tx: TenantTx) => Promise<T>) =>
          userId && deps.withUser ? deps.withUser(t.orgId, userId, fn) : deps.withTenant(t.orgId, fn);
        const answers = await tenant((tx) =>
          dashboards.requestDashboardQueries({ boss }, tx, viewer(t), {
            dashboardId: input.dashboardId,
            revision: input.revision,
            requests: input.requests as dashboards.DashboardRequest[],
            retry: input.retry ?? false,
          }),
        );
        if (!answers) throw errors.NOT_FOUND();
        return answers;
      }),
      work: authed.dashboards.work.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = viewer(t).userId;
        const canWork = Boolean(userId) && t.role !== "viewer";
        const tenant = <T>(fn: (tx: TenantTx) => Promise<T>) =>
          userId && deps.withUser ? deps.withUser(t.orgId, userId, fn) : deps.withTenant(t.orgId, fn);
        try {
          const work = await tenant(async (tx) => {
            if (input.set) {
              if (!canWork || !userId)
                throw errors.NOT_FOUND({ message: "Viewers read this list; they don't work in it." });
              await dashboards.setWork(
                tx,
                { ...viewer(t), userId },
                {
                  dashboardId: input.dashboardId,
                  revision: input.revision,
                  section: input.section,
                  ...input.set,
                  ...(input.snapshot ? { snapshot: input.snapshot } : {}),
                },
              );
            }
            const work = await dashboards.readWork(tx, viewer(t), {
              dashboardId: input.dashboardId,
              revision: input.revision,
              section: input.section,
              keys: input.set ? [...input.keys, input.set.key] : input.keys,
              ...(input.snapshot ? { snapshot: input.snapshot } : {}),
            });
            const history =
              work && input.history
                ? await dashboards.readWorkHistory(tx, viewer(t), {
                    dashboardId: input.dashboardId,
                    revision: input.revision,
                    section: input.section,
                    key: input.history,
                    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
                  })
                : null;
            return work ? { work, history } : null;
          });
          if (!work) throw errors.NOT_FOUND();
          // The people a record can go to: for a person reading it (never an organization key), by name only.
          return {
            work: work.work,
            people: userId && deps.people ? (await deps.people(t.orgId)).map((p) => ({ id: p.id, name: p.name })) : [],
            canWork,
            ...(work.history ? { history: work.history } : {}),
          };
        } catch (error) {
          if (error instanceof dashboards.DashboardProblem) {
            if (error.code === "not_found") throw errors.NOT_FOUND({ message: error.message });
            throw errors.INVALID({ message: error.message });
          }
          throw error;
        }
      }),
      action: authed.dashboards.action.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = viewer(t).userId;
        // A change is a person's, with their own account: never an organization key's, never a viewer's.
        if (!userId || t.role === "viewer" || !deps.withUser) {
          throw errors.NOT_FOUND({ message: "Viewers read this list; they don't change things from it." });
        }
        try {
          return await deps.withUser(t.orgId, userId, (tx) =>
            dashboards.prepareAction(tx, { ...viewer(t), userId }, input),
          );
        } catch (error) {
          if (error instanceof dashboards.DashboardProblem) {
            if (error.code === "not_found") throw errors.NOT_FOUND({ message: error.message });
            throw errors.INVALID({ message: error.message });
          }
          throw error;
        }
      }),
      actionRun: authed.dashboards.actionRun.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = viewer(t).userId;
        if (!userId || t.role === "viewer") throw errors.NOT_FOUND();
        if (!deps.mcp) throw errors.INVALID({ message: "Connections aren't set up on this server." });
        try {
          return await dashboards.runAction(deps.mcp, { ...viewer(t), userId }, input.ticket);
        } catch (error) {
          if (error instanceof dashboards.DashboardProblem) {
            if (error.code === "not_found") throw errors.NOT_FOUND({ message: error.message });
            throw errors.INVALID({ message: error.message });
          }
          throw error;
        }
      }),
      summary: authed.dashboards.summary.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const boss = await deps.boss();
        const userId = viewer(t).userId;
        const tenant = <T>(fn: (tx: TenantTx) => Promise<T>) =>
          userId && deps.withUser ? deps.withUser(t.orgId, userId, fn) : deps.withTenant(t.orgId, fn);
        const answer = await tenant((tx) =>
          dashboards.summaryAnswer({ boss }, tx, viewer(t), {
            dashboardId: input.dashboardId,
            revision: input.revision,
            section: input.section,
            filters: input.filters,
            ...(input.write ? { write: true } : {}),
            ...(input.again ? { again: true } : {}),
            ...(input.angle ? { angle: input.angle } : {}),
          }),
        );
        if (!answer) throw errors.NOT_FOUND();
        // What it cost is for those who look after spending: owners and admins.
        if (answer.status === "ok" && answer.cost && t.role !== "owner" && t.role !== "admin") {
          const { cost: _hidden, ...rest } = answer;
          return rest;
        }
        return answer;
      }),
      versions: authed.dashboards.versions.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const list = await deps.withTenant(t.orgId, (tx) => dashboards.listVersions(tx, viewer(t), input.dashboardId));
        if (!list) throw errors.NOT_FOUND();
        const names = await ownerNames(
          t.orgId,
          list.map((v) => v.authorId),
        );
        return list.map((v) => ({
          version: v.version,
          createdAt: v.createdAt,
          changeNote: v.changeNote,
          by: v.authorId ? (v.authorId === t.userId ? "You" : (names[v.authorId] ?? "Someone who left")) : "OpenDash",
        }));
      }),
      renderCheck: authed.dashboards.renderCheck.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        const kept = await dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            dashboards.saveRenderCheck(tx, { orgId: t.orgId, userId }, input.dashboardId, input),
          ),
        );
        return { kept };
      }),
      // One line per open, ids and counts only: read where the logs are, never kept in the database.
      opened: authed.dashboards.opened.handler(({ context, input }) => {
        logger.info("dashboard open", { orgId: context.tenant.orgId, ...input });
        return { logged: true };
      }),
      undoable: authed.dashboards.undoable.handler(async ({ context, input }) => {
        const t = context.tenant;
        if (!t.userId) return [];
        const userId = t.userId;
        return deps.withTenant(t.orgId, (tx) =>
          dashboards.undoable(tx, { orgId: t.orgId, userId }, input.dashboardIds, input.runId),
        );
      }),
      undo: authed.dashboards.undo.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        return dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            dashboards.undoRun(tx, { orgId: t.orgId, userId }, input.dashboardId, input.runId),
          ),
        );
      }),
      restore: authed.dashboards.restore.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        const out = await dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            dashboards.restoreVersion(tx, { orgId: t.orgId, userId }, input.dashboardId, input),
          ),
        );
        if (!out.ok) {
          throw errors.INVALID({
            message: `Version ${input.version} doesn't pass today's checks: ${out.problems
              .slice(0, 3)
              .map((p) => `${p.path}: ${p.message}`)
              .join("; ")}`,
          });
        }
        return { version: out.version };
      }),
      publish: authed.dashboards.publish.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        const out = await dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            dashboards.publishDraft(tx, { orgId: t.orgId, userId }, input.dashboardId, { revision: input.revision }),
          ),
        );
        void track({
          event: "dashboard_published",
          userId,
          orgId: t.orgId,
          properties: { version: out.version, first: out.version === 1 },
        });
        return { version: out.version };
      }),
      share: authed.dashboards.share.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        await dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            dashboards.setDashboardVisibility(tx, { orgId: t.orgId, userId }, input.dashboardId, input.visibility),
          ),
        );
        return { visibility: input.visibility };
      }),
      shares: authed.dashboards.shares.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        const shares = await dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) => dashboards.listShares(tx, { orgId: t.orgId, userId }, input.dashboardId)),
        );
        const members = deps.people ? await deps.people(t.orgId) : [];
        const byId = new Map(members.map((m) => [m.id, m]));
        // Someone not among the members listed (past the directory's bound) is still named; one who left isn't.
        const names = await ownerNames(
          t.orgId,
          shares.filter((p) => !byId.has(p.userId)).map((p) => p.userId),
        );
        return {
          people: shares.map((p) => ({
            userId: p.userId,
            name: byId.get(p.userId)?.name ?? names[p.userId] ?? "Someone who left",
            email: byId.get(p.userId)?.email ?? "",
            role: p.role,
            addedAt: p.addedAt,
          })),
          members: members
            .filter((m) => m.id !== userId)
            .map((m) => ({ userId: m.id, name: m.name, email: m.email ?? "", viewer: m.role === "viewer" })),
        };
      }),
      sharePerson: authed.dashboards.sharePerson.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        await dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            dashboards.shareDashboard(tx, { orgId: t.orgId, userId }, input.dashboardId, {
              userId: input.userId,
              role: input.role,
            }),
          ),
        );
        return { role: input.role };
      }),
      delete: authed.dashboards.delete.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = person(t, errors);
        await dashboardCall(errors, () =>
          deps.withTenant(t.orgId, (tx) =>
            dashboards.deleteDashboard(tx, { orgId: t.orgId, userId, canManage: manages(t) }, input.dashboardId),
          ),
        );
        return { deleted: true };
      }),
      star: authed.dashboards.star.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        person(t, errors);
        const done = await deps.withTenant(t.orgId, (tx) =>
          setDashboardStar(tx, viewer(t), input.dashboardId, input.starred),
        );
        if (!done) throw errors.NOT_FOUND();
        return { starred: input.starred };
      }),
    },
    sources: {
      askable: authed.sources.askable.handler(({ context }) =>
        deps.withTenant(context.tenant.orgId, (tx) => askableSources(tx, context.tenant.orgId)),
      ),
      suggestions: authed.sources.suggestions.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        return deps.withTenant(t.orgId, async (tx) => {
          if (!(await getSource(tx, t.orgId, input.connectionId))) throw errors.NOT_FOUND();
          return suggestedQuestions(tx, t.orgId, input.connectionId);
        });
      }),
      learning: authed.sources.learning.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "What OpenDash learns is chosen by the organization's owners and admins.");
        const choice = await deps.withTenant(t.orgId, (tx) => learningChoice(tx, t.orgId, input.connectionId));
        if (!choice) throw errors.NOT_FOUND();
        return choice;
      }),
      chooseLearned: authed.sources.chooseLearned.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "What OpenDash learns is chosen by the organization's owners and admins.");
        if (!t.userId) throw errors.FORBIDDEN({ message: "What's learned is chosen by a person: use a user API key." });
        const userId = t.userId;
        const boss = await deps.boss();
        try {
          return await deps.withTenant(t.orgId, (tx) =>
            chooseLearnedTables({ boss }, tx, { orgId: t.orgId, userId }, input.connectionId, input.tables),
          );
        } catch (error) {
          if (!(error instanceof LearningProblem)) throw error;
          throw error.code === "not_found"
            ? errors.NOT_FOUND({ message: error.message })
            : errors.INVALID({ message: error.message });
        }
      }),
      readiness: authed.sources.readiness.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "A source's readiness is for the organization's owners and admins.");
        return deps.withTenant(t.orgId, async (tx) => {
          if (!(await getSource(tx, t.orgId, input.connectionId))) throw errors.NOT_FOUND();
          return sourceReadiness(tx, t.orgId, input.connectionId);
        });
      }),
    },
    threads: {
      share: authed.threads.share.handler(async ({ context, input, errors }) => {
        if (!(await shareThread(deps, viewer(context.tenant), input.threadId, input.visibility))) {
          throw errors.NOT_FOUND({
            message:
              input.visibility === "project"
                ? "Only the person who started this conversation can share it, once it's in a project."
                : "Only the person who started this conversation can share it.",
          });
        }
        return { visibility: input.visibility };
      }),
      star: authed.threads.star.handler(async ({ context, input, errors }) => {
        if (!context.tenant.userId)
          throw errors.FORBIDDEN({ message: "Stars belong to a person: use a user API key." });
        if (!(await setThreadStar(deps, viewer(context.tenant), input.threadId, input.starred)))
          throw errors.NOT_FOUND();
        return { starred: input.starred };
      }),
      list: authed.threads.list.handler(async ({ context, input }) =>
        withAuthors(
          context.tenant.orgId,
          await listThreadPage(deps, viewer(context.tenant), {
            scope: input.scope,
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.state ? { state: input.state } : {}),
            ...(input.q ? { q: input.q } : {}),
            ...(input.attached ? { attached: input.attached } : {}),
            limit: input.limit,
            offset: input.offset,
          }).then((page) => page.threads),
        ),
      ),
      get: authed.threads.get.handler(async ({ context, input, errors }) => {
        const thread = await getThread(deps, viewer(context.tenant), input.threadId);
        if (!thread) throw errors.NOT_FOUND();
        const [listed] = await withAuthors(context.tenant.orgId, [thread.thread]);
        return { thread: listed as ThreadListing, turns: thread.turns };
      }),
    },
    ask: {
      readReference: authed.ask.readReference.handler(async ({ context, input, errors }) => {
        // A few files a minute a person: reading a PDF is work, and nobody needs more.
        const who = `${context.tenant.orgId}:${context.tenant.userId ?? "key"}`;
        const now = Date.now();
        const recent = (readsBy.get(who) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= 30) throw errors.TOO_MANY_READS();
        readsBy.set(who, [...recent, now]);
        const read = await readReference({
          name: input.name,
          bytes: Uint8Array.from(Buffer.from(input.data, "base64")),
        });
        return { ...read, id: uuidv7() };
      }),
      attachable: authed.ask.attachable.handler(({ context, input }) => {
        const t = context.tenant;
        return deps.withTenant(t.orgId, (tx) =>
          attachable(tx, { orgId: t.orgId, userId: t.userId }, input.connectionId, input.q ?? ""),
        );
      }),
      submit: authed.ask.submit.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        if (t.role === "viewer") {
          throw errors.FORBIDDEN({ message: "Viewers read shared conversations. Ask an admin for the Member role." });
        }
        // A new conversation starts from a source, and a follow-up can switch to another: either way it
        // must be ready to be asked about.
        if (input.connectionId) {
          const source = await deps.withTenant(t.orgId, (tx) => getSource(tx, t.orgId, input.connectionId as string));
          if (!source?.learnedAt) throw errors.NOT_FOUND({ message: "That source isn't ready to be asked about yet." });
        }
        try {
          const boss = await deps.boss();
          const choice = await deps.withTenant(t.orgId, (tx) =>
            choiceForQuestion(tx, t.orgId, deps.deploymentKeys, {
              model: input.model,
              provider: input.provider,
              reasoning: input.reasoning,
            }),
          );
          const r = await submitQuestion(
            { withTenant: deps.withTenant, boss },
            {
              orgId: t.orgId,
              userId: t.userId,
              ...(input.connectionId ? { connectionId: input.connectionId } : {}),
              ...(input.threadId ? { threadId: input.threadId } : {}),
              ...(input.clientMsgId ? { clientMsgId: input.clientMsgId } : {}),
              text: input.text,
              channel: t.channel,
              model: choice.model,
              provider: choice.provider,
              reasoning: choice.reasoning,
              ...(input.attachments?.length ? { attachments: input.attachments } : {}),
              // Trying a skill's draft is for owners and admins, decided here from the caller's role, never the client.
              canTryDrafts: t.userId !== null && (t.role === "owner" || t.role === "admin"),
              ...(input.projectId && !input.threadId
                ? { project: { id: input.projectId, orgRole: t.role ?? "member" } }
                : {}),
            },
          );
          void track({
            event: "question_asked",
            userId: t.userId,
            orgId: t.orgId,
            properties: {
              channel: t.channel,
              follow_up: Boolean(input.threadId),
              attachments: input.attachments?.length ?? 0,
            },
          });
          return { threadId: r.threadId, runId: r.runId, queued: r.queued };
        } catch (error) {
          if (error instanceof SpendLimitReached) throw errors.SPEND_LIMIT({ message: error.message });
          if (error instanceof AiProblem || error instanceof AttachmentProblem) {
            throw errors.INVALID({ message: error.message });
          }
          if (error instanceof NotFound || error instanceof ProjectNotFound) {
            throw errors.NOT_FOUND({ message: error.message });
          }
          if (error instanceof NotYours || error instanceof ProjectRefused) {
            throw errors.FORBIDDEN({ message: error.message });
          }
          if (error instanceof RunActive) throw errors.RUN_ACTIVE();
          throw error;
        }
      }),
      takeBack: authed.ask.takeBack.handler(async ({ context, input }) => ({
        takenBack: await takeBackFollowUp(deps, viewer(context.tenant), input.messageId),
      })),
    },
    runs: {
      events: authed.runs.events.handler(async ({ context, input, errors }) => {
        const v = viewer(context.tenant);
        // Owners and admins follow background work too (a drafting batch).
        const follows = { manages: manages(context.tenant) };
        const run = await getRun(deps, v, input.runId, follows);
        if (!run) throw errors.NOT_FOUND();
        const events = await runEvents(deps, v, input.runId, input.afterSeq, follows);
        return {
          events: events.map((e) => ({
            seq: e.seq,
            attempt: e.attempt,
            type: e.type,
            data: e.data,
            createdAt: new Date(e.created_at).toISOString(),
          })),
          run: { status: run.status, attempt: run.attempt, outcome: run.outcome, error: run.error },
        };
      }),
      trace: authed.runs.trace.handler(async ({ context, input, errors }) => {
        const view = await traceFor(deps, { ...viewer(context.tenant), manages: manages(context.tenant) }, input.runId);
        if (!view) throw errors.NOT_FOUND();
        return view;
      }),
      step: authed.runs.step.handler(({ context, input }) =>
        callDetail(deps, { ...viewer(context.tenant), manages: manages(context.tenant) }, input.runId, input.callId),
      ),
      recent: authed.runs.recent.handler(async ({ context, input }) => {
        const t = context.tenant;
        const runs = await recentRuns(
          deps,
          { ...viewer(t), manages: manages(t) },
          {
            limit: input.limit,
            ...(input.before ? { before: input.before } : {}),
            ...(input.background ? { background: true } : {}),
          },
        );
        const names = await ownerNames(
          t.orgId,
          runs.map((r) => r.askedBy),
        );
        return runs.map((r) => ({ ...r, askedByName: r.askedBy ? (names[r.askedBy] ?? null) : null }));
      }),
      stop: authed.runs.stop.handler(async ({ context, input }) => ({
        // Stopping a run that hasn't started passes on what was typed meanwhile: the queue starts it.
        stopped: await requestStop(
          { withTenant: deps.withTenant, boss: await deps.boss() },
          viewer(context.tenant),
          input.runId,
        ),
      })),
    },
    queries: {
      records: authed.queries.records.handler(async ({ context, input }) =>
        requestRecords({ withTenant: deps.withTenant, boss: await deps.boss() }, viewer(context.tenant), {
          queryRunId: input.queryRunId,
          ...(input.row !== undefined ? { row: input.row } : {}),
          ...(input.group ? { group: input.group } : {}),
          page: input.page,
          ...(input.pageSize ? { pageSize: input.pageSize } : {}),
          ...(input.expected !== undefined ? { expected: input.expected } : {}),
        }),
      ),
      get: authed.queries.get.handler(async ({ context, input, errors }) => {
        const card = await getQueryCard(deps, viewer(context.tenant), input.queryRunId);
        if (!card) throw errors.NOT_FOUND();
        return card;
      }),
    },
    feedback: {
      give: authed.feedback.give.handler(async ({ context, input, errors }) => {
        const r = await giveFeedback(deps, viewer(context.tenant), {
          runId: input.runId,
          kind: input.kind,
          ...(input.queryRunId ? { queryRunId: input.queryRunId } : {}),
          ...(input.claimKey ? { claimKey: input.claimKey } : {}),
          ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
          ...(input.comment ? { comment: input.comment } : {}),
          ...(input.correction ? { correction: input.correction } : {}),
        });
        if (!r) throw errors.NOT_FOUND();
        return r;
      }),
      withdraw: authed.feedback.withdraw.handler(async ({ context, input }) => ({
        withdrawn: await withdrawFeedback(deps, viewer(context.tenant), input.runId),
      })),
      mine: authed.feedback.mine.handler(({ context, input }) => myFeedback(deps, viewer(context.tenant), input.runId)),
    },
    // Learnings: owners and admins approve, revert and reject; anyone who corrected sees their own.
    learning: {
      forRun: authed.learning.forRun.handler(({ context, input }) => {
        const t = context.tenant;
        return deps.withTenant(t.orgId, (tx) =>
          learningsForRun(tx, { orgId: t.orgId, userId: t.userId, approver: manages(t) }, input.runId),
        );
      }),
      list: authed.learning.list.handler(({ context, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Learnings are for the organization's owners and admins.");
        return deps.withTenant(t.orgId, (tx) => listLearnings(tx, { orgId: t.orgId, userId: t.userId }));
      }),
      approve: authed.learning.approve.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Owners and admins make a learning the team's.");
        const userId = t.userId;
        if (!userId) throw errors.FORBIDDEN({ message: "A learning is approved by a person." });
        const approved = await deps.withTenant(t.orgId, (tx) =>
          approveLearning(tx, { orgId: t.orgId, userId }, input.id),
        );
        if (!approved) throw errors.NOT_FOUND({ message: "That learning isn't waiting for approval." });
        return { approved };
      }),
      revert: authed.learning.revert.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Owners and admins revert a learning.");
        const userId = t.userId;
        if (!userId) throw errors.FORBIDDEN({ message: "A learning is reverted by a person." });
        const reverted = await deps.withTenant(t.orgId, (tx) =>
          revertLearning(tx, { orgId: t.orgId, userId }, input.id),
        );
        if (reverted === "not_found") throw errors.NOT_FOUND({ message: "That learning isn't the team's to revert." });
        if (reverted === "superseded") throw errors.INVALID({ message: REVERT_SUPERSEDED });
        return { reverted: true };
      }),
      reject: authed.learning.reject.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Owners and admins reject a learning.");
        const userId = t.userId;
        if (!userId) throw errors.FORBIDDEN({ message: "A learning is rejected by a person." });
        const rejected = await deps.withTenant(t.orgId, (tx) =>
          rejectLearning(tx, { orgId: t.orgId, userId }, input.id, input.note ?? null),
        );
        if (!rejected) throw errors.NOT_FOUND({ message: "That learning can't be rejected now." });
        return { rejected };
      }),
      edit: authed.learning.edit.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        admins(t, errors, "Owners and admins change a learning before it's the team's.");
        const userId = t.userId;
        if (!userId) throw errors.FORBIDDEN({ message: "A learning is changed by a person." });
        const boss = await deps.boss();
        const { id, ...edit } = input;
        try {
          const edited = await deps.withTenant(t.orgId, (tx) =>
            editLearning({ boss }, tx, { orgId: t.orgId, userId }, id, edit),
          );
          if (!edited) throw errors.NOT_FOUND({ message: "That learning isn't waiting for a tap." });
          return { edited };
        } catch (error) {
          if (error instanceof ContextProblem) throw errors.INVALID({ message: error.message });
          throw error;
        }
      }),
      suggest: authed.learning.suggest.handler(async ({ context, input, errors }) => {
        const t = context.tenant;
        const userId = t.userId;
        if (!userId || t.role === "viewer" || !deps.withUser) {
          throw errors.FORBIDDEN({ message: "Members suggest learnings from their own corrections." });
        }
        const made = await deps.withUser(t.orgId, userId, (tx) =>
          suggestLearning(tx, { orgId: t.orgId, userId }, input.memoryId),
        );
        if (!made) throw errors.NOT_FOUND({ message: "That memory isn't yours, or isn't from an answer." });
        return made;
      }),
    },
  });
}

export type ApiRouter = ReturnType<typeof createRouter>;
