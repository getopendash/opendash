/**
 * A run's model. AGENTS.md: models come from a provider, built per run from the workspace's credentials
 * (opened here, in the worker, only) or the deployment's own, never a bare model id string. A run's model is resolved
 * once: the run says its model, its provider and its level; the provider must be working and still offer the model;
 * its instance comes from providers/build.ts with every credential passed explicitly.
 */
import {
  BUDGETS,
  catalogModel,
  defaultLevelOf,
  deploymentKeys,
  type Effort,
  effortOf,
  type GatewayDeps,
  MAKERS,
  type ProviderKind,
  providerForRun,
  type SecretStore,
} from "@opendash/core";
import type { LanguageModel } from "ai";
import { callOptions, deploymentEndpoint, languageModel, type Route, workspaceEndpoint } from "../providers/build";
import type { AgentDeps } from "./deps";

/** The run can't get a model at all; retrying won't help, so the run fails with this message. */
export class ModelUnavailable extends Error {
  override name = "ModelUnavailable";
}

/** A model call's stream went quiet: no first byte, or too long a gap between bytes. A retry may get through. */
export class ModelStalled extends Error {
  override name = "ModelStalled";
}

/**
 * A provider's fetch with a watchdog on the model call's own stream: the response's first byte within
 * `firstByteMs`, then no gap between bytes longer than `idleMs`, else the request is aborted with ModelStalled. Only
 * the call is timed: a step's tools run after the response ends, outside it, where the SDK's stepMs and chunkMs would
 * count their time as the model's.
 */
export function watchedFetch(
  base: typeof fetch = fetch,
  limits: { firstByteMs: number; idleMs: number } = {
    firstByteMs: BUDGETS.agent.modelFirstByteMs,
    idleMs: BUDGETS.agent.modelIdleMs,
  },
): typeof fetch {
  return async (input, init) => {
    const watch = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, watch.signal]) : watch.signal;
    /** Ends the response's stream at once, whatever the provider's own stream does once its request is aborted. */
    let fail: (reason: unknown) => void = () => {};
    const stall = (what: string) => () => {
      const reason = new ModelStalled(`The model's response ${what}.`);
      watch.abort(reason);
      fail(reason);
    };
    let timer = setTimeout(stall(`didn't start within ${limits.firstByteMs / 1000} s`), limits.firstByteMs);
    let response: Response;
    try {
      response = await base(input, { ...init, signal });
    } catch (error) {
      clearTimeout(timer);
      throw watch.signal.aborted ? watch.signal.reason : error;
    }
    if (!response.body) {
      clearTimeout(timer);
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        fail = (reason) => {
          controller.error(reason);
          reader.cancel(reason).catch(() => {});
        };
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          clearTimeout(timer);
          if (watch.signal.aborted) return;
          if (done) {
            controller.close();
            return;
          }
          timer = setTimeout(stall(`went quiet for ${limits.idleMs / 1000} s`), limits.idleMs);
          controller.enqueue(value);
        } catch (error) {
          clearTimeout(timer);
          if (!watch.signal.aborted) controller.error(error);
        }
      },
      cancel(reason) {
        clearTimeout(timer);
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export interface ResolvedModel {
  model: LanguageModel;
  /** The provider it runs on, by kind. */
  provider: ProviderKind;
  /**
   * How its calls go (a maker's API, a gateway, a cloud): what a transcript's reasoning is kept for, since a
   * provider's signed thinking can only go back the way it came.
   */
  route: Route;
  /** How long it thinks: the AI SDK's `reasoning`, or none where a route takes it in its own options. */
  reasoning?: Effort;
  /** What the route's calls send besides the conversation. */
  providerOptions: Record<string, Record<string, unknown>>;
  /** Whose account pays: the workspace's own provider, or the deployment's. */
  keySource: "org" | "deployment";
}

/** What a provider that can't run a model says, with what to do. */
function unavailable(label: string, state: string, kind: ProviderKind): string {
  if (kind === "opendash" && state === "not_working") {
    return "There are no AI keys on this server: set up a provider in Settings → AI.";
  }
  if (state === "off") return `${label} is turned off here: choose another model, or ask an admin to turn it on.`;
  if (state === "not_set_up") return `${label} isn't set up any more: choose another model.`;
  if (state === "testing") return `${label} is still being tested: ask again in a minute.`;
  return `${label} isn't working: an admin can test it again in Settings → AI.`;
}

/**
 * The worker's resolver: a run's model on its provider. A model OpenDash no longer allows, a provider that isn't
 * working or no longer offers the model, or a deployment with no key for it fail the run at once with what to do.
 */
export function createModelResolver(deps: {
  withTenant: GatewayDeps["withTenant"];
  secrets: SecretStore;
  env?: NodeJS.ProcessEnv;
}): AgentDeps["model"] {
  const env = deps.env ?? process.env;
  return async ({ orgId, modelId, provider = "opendash", reasoning }) => {
    const model = catalogModel(modelId);
    if (!model)
      throw new ModelUnavailable(`${modelId} isn't a model OpenDash allows any more: ask again with another.`);
    // The level chosen when the model takes it; otherwise the model's own default.
    const effort = effortOf(model.id, reasoning ?? defaultLevelOf(model.id));
    const fetch = watchedFetch();
    const p = await deps.withTenant(orgId, (tx) => providerForRun(deps, tx, orgId, provider, deploymentKeys(env)));
    if (p.state !== "working") throw new ModelUnavailable(unavailable(p.label, p.state, provider));
    const listed = p.available[model.id];
    if (!listed) throw new ModelUnavailable(`${p.label} doesn't offer ${model.label}: ask again with another model.`);
    // Only what an admin offers runs (ticked in Settings → AI), whoever asks: a stored default, a routine, an old link.
    if (!p.picked.includes(model.id)) {
      throw new ModelUnavailable(
        `${model.label} isn't offered through ${p.label} here: choose another, or ask an admin to offer it in Settings → AI.`,
      );
    }
    if (provider === "opendash") {
      const endpoint = deploymentEndpoint(model.maker, env);
      if (!endpoint) {
        throw new ModelUnavailable(
          `There's no ${MAKERS[model.maker].label} key on this server: set up a provider in Settings → AI.`,
        );
      }
      return {
        model: languageModel(endpoint, model.maker, listed, fetch),
        provider,
        route: endpoint.route,
        ...callOptions(endpoint.route, model, effort),
        keySource: "deployment",
      };
    }
    if (!p.credentials) throw new ModelUnavailable(unavailable(p.label, "not_working", provider));
    const route = provider as Route;
    return {
      model: languageModel(workspaceEndpoint(route, p.credentials), model.maker, listed, fetch),
      provider,
      route,
      ...callOptions(route, model, effort),
      keySource: "org",
    };
  };
}
