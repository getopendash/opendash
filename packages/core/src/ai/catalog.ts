/**
 * The allowlist: the only models OpenDash runs, on any provider. A model is listed when it's current and
 * good with tools and SQL, and taken off when its successor arrives; model ids are configuration, never code,
 * so a new model is an entry here. Each id is its maker's own API id. A provider's list names the same model its own
 * way (`anthropic/claude-sonnet-5.5`, `us.anthropic.claude-sonnet-5-5-v1:0`): match.ts finds it there.
 *
 * Prices are list prices in USD per million tokens. Anthropic's are from https://platform.claude.com/docs/en/about-claude/pricing
 * as of 2026-10-10 (cache reads on Sonnet 5.5 fell from $0.20 to $0.10 on 2026-10-07); a cache write is the 5-minute
 * kind, the one `ephemeral` cache control makes. OpenAI's and Google's are from Vercel AI Gateway's public model list
 * (https://ai-gateway.vercel.sh/v1/models) as of 2026-10-20, which passes list prices through; Google charges no cache
 * write, so a write costs what input does. A cloud's regional surcharge isn't included. Each call's cost is worked out
 * when it's made and stored on its usage_event, so a later price change never rewrites a past call.
 *
 * Thinking: each model lists the levels it takes and the AI SDK `reasoning` value each sends. Auto is
 * what the model was measured on, sent explicitly: `provider-default` would send nothing, and a model that thinks only
 * when asked would stop. Claude: `high` is what omitting effort does (platform.claude.com, effort, read 2026-10-20),
 * with adaptive thinking summarized (the SDK adds both). OpenAI: medium, as before. Gemini 3: its thinking level high,
 * as before; it takes low, medium and high only, so it has no Deep or Max.
 */
export type Maker = "anthropic" | "openai" | "google";

export const MAKERS: Record<Maker, { label: string }> = {
  anthropic: { label: "Anthropic" },
  openai: { label: "OpenAI" },
  google: { label: "Google" },
};

/** How long a model thinks before it answers, as people choose it. */
/**
 * How long a model thinks: the standard effort levels (low, medium, high, extra and max), each sent to the model as
 * itself. A model takes some of them, and starts at its maker's default.
 */
export type Level = "low" | "medium" | "high" | "xhigh" | "max";

export const LEVELS: { id: Level; label: string; blurb: string }[] = [
  { id: "low", label: "Low", blurb: "Thinks briefly. Fastest and cheapest, for simple lookups." },
  { id: "medium", label: "Medium", blurb: "Some thought. Quick, for everyday questions." },
  { id: "high", label: "High", blurb: "Thinks it through. Claude's default, and what OpenDash is measured on." },
  { id: "xhigh", label: "Extra", blurb: "Extra high: thinks longer first. Slower, for hard questions and Apps." },
  { id: "max", label: "Max", blurb: "As long as it needs. The slowest and most expensive." },
];

export const isLevel = (v: unknown): v is Level => LEVELS.some((l) => l.id === v);

/** The AI SDK's `reasoning` values OpenDash sends: a level is sent as itself. */
export type Effort = Level;

export interface ModelPrice {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** A higher price for prompts over a size (Haiku 5.5: over 100,000 input tokens, cache reads and writes included). */
  above?: { inputTokens: number; price: Omit<ModelPrice, "above"> };
}

export interface CatalogModel {
  id: string;
  maker: Maker;
  label: string;
  /** What it's for, in a few words. */
  blurb: string;
  /** Its context window in tokens, when its maker's docs list it; otherwise contextWindow assumes the smallest. */
  window?: number;
  /** The levels it takes, and the one it starts at (its maker's default). */
  levels: { takes: readonly Level[]; default: Level };
  /** Its list price, or null when it hasn't been sourced: its cost is unknown then, never zero. */
  price: ModelPrice | null;
  /** Measured with the analyst: the golden set's score and when, or null (its tool loop isn't verified on it). */
  measured: { set: "golden"; passed: number; total: number; on: string } | null;
  /** The cheapest of its maker's models: a provider's test call uses it. */
  testModel?: boolean;
  /**
   * Its id on Vercel AI Gateway, which OpenDash's own calls use when the deployment has a gateway key (a workspace's
   * gateway reads its own list). Checked against the gateway's public list (test/ai-catalog.test.ts).
   */
  gateway: string;
}

const CLAUDE_LEVELS = { takes: ["low", "medium", "high", "xhigh", "max"], default: "high" } as const;
const GPT_LEVELS = { takes: ["low", "medium", "high", "max"], default: "medium" } as const;
const GEMINI_LEVELS = { takes: ["low", "high"], default: "high" } as const;
const GOLDEN = { set: "golden", passed: 21, total: 21, on: "2026-10-10" } as const;

export const CATALOG: readonly CatalogModel[] = [
  {
    id: "claude-sonnet-5-5",
    gateway: "anthropic/claude-sonnet-5.5",
    maker: "anthropic",
    label: "Claude Sonnet 5.5",
    blurb: "Balanced: strong and quick",
    levels: CLAUDE_LEVELS,
    price: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
    measured: GOLDEN,
  },
  {
    id: "claude-opus-5-5",
    gateway: "anthropic/claude-opus-5.5",
    maker: "anthropic",
    label: "Claude Opus 5.5",
    blurb: "The most capable",
    levels: CLAUDE_LEVELS,
    price: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
    measured: GOLDEN,
  },
  {
    id: "claude-haiku-5-5",
    gateway: "anthropic/claude-haiku-5.5",
    maker: "anthropic",
    label: "Claude Haiku 5.5",
    blurb: "The fastest and cheapest",
    levels: CLAUDE_LEVELS,
    price: {
      input: 0.1,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      output: 0.5,
      above: { inputTokens: 100_000, price: { input: 0.5, cacheRead: 0.05, cacheWrite: 0.625, output: 2.5 } },
    },
    measured: GOLDEN,
    testModel: true,
  },
  {
    id: "claude-fable-5-1",
    gateway: "anthropic/claude-fable-5.1",
    maker: "anthropic",
    label: "Claude Fable 5.1",
    blurb: "For the hardest questions",
    // platform.claude.com/docs/en/build-with-claude/context-windows, read 2026-10-15.
    window: 1_000_000,
    levels: CLAUDE_LEVELS,
    price: { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
    measured: GOLDEN,
  },
  {
    id: "gpt-6.1-sol",
    gateway: "openai/gpt-6.1-sol",
    maker: "openai",
    label: "GPT-6.1 Sol",
    blurb: "OpenAI's flagship",
    levels: GPT_LEVELS,
    price: {
      input: 2,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      output: 10,
      above: { inputTokens: 272_000, price: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 } },
    },
    measured: null,
  },
  {
    id: "gpt-6-luna",
    gateway: "openai/gpt-6-luna",
    maker: "openai",
    label: "GPT-6 Luna",
    blurb: "OpenAI's faster model",
    levels: GPT_LEVELS,
    price: {
      input: 0.1,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      output: 0.5,
      above: { inputTokens: 272_000, price: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 } },
    },
    measured: null,
    testModel: true,
  },
  {
    id: "gemini-3.1-pro-preview",
    gateway: "google/gemini-3.1-pro-preview",
    maker: "google",
    label: "Gemini 3.1 Pro (preview)",
    blurb: "Google's most capable, in preview",
    levels: GEMINI_LEVELS,
    price: {
      input: 2,
      cacheRead: 0.2,
      cacheWrite: 2,
      output: 12,
      above: { inputTokens: 200_000, price: { input: 4, cacheRead: 0.4, cacheWrite: 4, output: 18 } },
    },
    measured: null,
  },
  {
    id: "gemini-3.8-flash",
    gateway: "google/gemini-3.8-flash",
    maker: "google",
    label: "Gemini 3.8 Flash",
    blurb: "Google's fast model",
    levels: GEMINI_LEVELS,
    price: { input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 3.75 },
    measured: null,
    testModel: true,
  },
];

/** The model a new workspace starts with: the one the analyst is measured on. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const catalogModel = (id: string): CatalogModel | undefined => CATALOG.find((m) => m.id === id);

/** Only allowlisted models run. */
export const isAllowed = (id: string): boolean => catalogModel(id) !== undefined;

/**
 * A model's context window in tokens. Anthropic's docs (context-windows, read 2026-10-15) list 1M for Fable 5.1 and
 * 200k for "other Claude models"; Haiku, Sonnet and Opus 5.5 aren't listed by name, and the OpenAI and Google models
 * aren't sourced. A model not listed gets 200k, the smallest window of a current model: at worst its conversation is
 * folded sooner than it needed to be.
 */
export const contextWindow = (id: string): number => catalogModel(id)?.window ?? 200_000;

export const priceOf = (id: string): ModelPrice | null => catalogModel(id)?.price ?? null;

/** The levels a model takes, in the order people see them (a model the catalog doesn't know: High only). */
export const levelsOf = (id: string): Level[] => {
  const m = catalogModel(id);
  return m ? LEVELS.map((l) => l.id).filter((l) => m.levels.takes.includes(l)) : ["high"];
};

/** The level a model starts at: its maker's default. */
export const defaultLevelOf = (id: string): Level => catalogModel(id)?.levels.default ?? "high";

/**
 * The level a run uses: the one chosen when the model takes it; one it doesn't take, the nearest it does (the lower of
 * two as near: Extra high on a model without it is High); none chosen, the model's default.
 */
export function levelFor(id: string, chosen: unknown): Level {
  if (!isLevel(chosen)) return defaultLevelOf(id);
  const takes = levelsOf(id);
  if (takes.includes(chosen)) return chosen;
  const order = LEVELS.map((l) => l.id);
  const at = order.indexOf(chosen);
  const distance = (l: Level) => Math.abs(order.indexOf(l) - at);
  return takes.reduce((best, l) => (distance(l) < distance(best) ? l : best), takes[0] ?? defaultLevelOf(id));
}

/** The `reasoning` value a run sends: its level, when the model takes it; else the model's default. */
export const effortOf = (id: string, level: Level): Effort => levelFor(id, level);

/** The model a provider is tested with for a maker: its cheapest. */
export const testModelOf = (maker: Maker, among: readonly string[] = CATALOG.map((m) => m.id)): CatalogModel | null => {
  const candidates = CATALOG.filter((m) => m.maker === maker && among.includes(m.id));
  return candidates.find((m) => m.testModel) ?? candidates[0] ?? null;
};
