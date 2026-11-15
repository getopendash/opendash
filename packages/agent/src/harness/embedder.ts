/**
 * Vectors: an organization's embedder, built in the worker like its models
 * (AGENTS.md: a provider instance per org, never a bare model id, and its own key decrypted only here). OpenAI's small
 * model at 1024 dimensions, paid by the organization's working OpenAI provider, else the deployment's
 * key; none (embeddings off, search by words alone) when it has neither, or when its own isn't working.
 */
import { createOpenAI } from "@ai-sdk/openai";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type Embedder,
  type GatewayDeps,
  openAiKeyFor,
  type SecretStore,
} from "@opendash/core";
import { embedMany } from "ai";
import { ENDPOINTS } from "../providers/build";

/** The provider's name for the model OpenDash records as EMBEDDING_MODEL. */
const OPENAI_MODEL = "text-embedding-3-small";

/** An embedder over an OpenAI key. */
export function openAiEmbedder(apiKey: string): Embedder {
  // Its endpoint passed explicitly, never OPENAI_BASE_URL's.
  const model = createOpenAI({ apiKey, baseURL: ENDPOINTS.openai }).embeddingModel(OPENAI_MODEL);
  return {
    model: EMBEDDING_MODEL,
    async embed(texts, signal) {
      if (!texts.length) return [];
      const { embeddings } = await embedMany({
        model,
        values: texts,
        providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
        maxParallelCalls: 2,
        maxRetries: 2,
        ...(signal ? { abortSignal: signal } : {}),
      });
      return embeddings;
    },
  };
}

/** The worker's resolver: an organization's embedder, or null when it has no working key and the deployment none. */
export function createEmbedderResolver(deps: {
  withTenant: GatewayDeps["withTenant"];
  secrets: SecretStore;
  env?: NodeJS.ProcessEnv;
  /** Tests: an embedder for a key, instead of OpenAI's. */
  make?: (apiKey: string) => Embedder;
}): (orgId: string) => Promise<Embedder | null> {
  const env = deps.env ?? process.env;
  const make = deps.make ?? openAiEmbedder;
  return async (orgId) => {
    const own = await deps.withTenant(orgId, (tx) => openAiKeyFor(deps, tx, orgId));
    if (own && "failed" in own) return null;
    const apiKey = own?.apiKey ?? env.OPENAI_API_KEY?.trim();
    return apiKey ? make(apiKey) : null;
  };
}
