/**
 * A provider's models are its own list met with the allowlist. Each provider names a
 * model its own way: `claude-sonnet-5-5` (Anthropic), `anthropic/claude-sonnet-5.5` (Vercel AI Gateway, OpenRouter),
 * `eu.anthropic.claude-sonnet-5-5-v1:0` (a Bedrock inference profile), `models/gemini-3.8-flash` (Google). A listed id
 * matches an allowlisted model when, with its maker's prefix, a Bedrock geography and a version suffix taken off, and
 * dots read as dashes, it is that model's id exactly: `claude-opus-5` is never `claude-opus-5-5`, and variants such as
 * `-batch`, `-fast` or `:batch` match nothing. What's kept is the id the provider listed, so a run calls it by that.
 */
import { CATALOG, type CatalogModel, type Maker } from "./catalog";
import { KINDS, type ProviderKind } from "./kinds";

/** Allowlisted model id → the id its provider listed it under. */
export type Available = Record<string, string>;

const GEOGRAPHIES = new Set(["global", "us", "eu", "apac", "jp", "au", "ca", "us-gov"]);
const MAKER_PREFIXES: Record<string, Maker> = { anthropic: "anthropic", openai: "openai", google: "google" };

/** The listed id's maker (when it says) and its bare name. */
export function parseListed(listed: string): { maker: Maker | null; name: string; geography: string | null } {
  let rest = listed.trim().toLowerCase();
  let maker: Maker | null = null;
  let geography: string | null = null;
  if (rest.startsWith("models/")) rest = rest.slice("models/".length);
  const slash = rest.lastIndexOf("/");
  if (slash >= 0) {
    // `anthropic/…`, or a path such as `publishers/anthropic/models/…`: someone else's model is never a match.
    maker =
      rest
        .slice(0, slash)
        .split("/")
        .map((s) => MAKER_PREFIXES[s])
        .find((m) => m !== undefined) ?? null;
    if (!maker) return { maker: null, name: "", geography };
    rest = rest.slice(slash + 1);
  }
  // Bedrock: `[geography.]anthropic.name[-v1:0]`.
  const parts = rest.split(".");
  if (parts.length >= 2 && GEOGRAPHIES.has(parts[0] as string) && MAKER_PREFIXES[parts[1] as string]) {
    geography = parts[0] as string;
    rest = parts.slice(1).join(".");
  }
  const dot = rest.indexOf(".");
  const vendor = dot > 0 ? rest.slice(0, dot) : "";
  if (MAKER_PREFIXES[vendor]) {
    maker = MAKER_PREFIXES[vendor] as Maker;
    rest = rest.slice(dot + 1);
  }
  const name = rest
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/-\d{8}$/, "")
    .replaceAll(".", "-");
  return { maker, name, geography };
}

const nameOf = (m: CatalogModel) => m.id.toLowerCase().replaceAll(".", "-");

/** A listed id's allowlisted model, if it is one, for a kind that can run that model's maker. */
export function allowlisted(kind: ProviderKind, listed: string): CatalogModel | null {
  const p = parseListed(listed);
  if (!p.name) return null;
  const m = CATALOG.find((c) => nameOf(c) === p.name && (p.maker === null || p.maker === c.maker));
  return m && KINDS[kind].serves.includes(m.maker) ? m : null;
}

/**
 * Which id to call a model by when its provider lists it more than once: the allowlist's own id, then a Bedrock
 * profile in the region's geography (a company that chose Frankfurt meant its calls to stay in Europe), then any
 * other, then a global profile last.
 */
function rank(listed: string, model: CatalogModel): number {
  if (listed === model.id) return 0;
  const g = parseListed(listed).geography;
  if (g !== null && g !== "global") return 1;
  return g === null ? 2 : 3;
}

/** A provider's list, met with the allowlist. */
export function matchListed(kind: ProviderKind, listed: readonly string[]): Available {
  const best = new Map<string, string>();
  for (const id of listed) {
    const m = allowlisted(kind, id);
    if (!m) continue;
    const had = best.get(m.id);
    if (had === undefined || rank(id, m) < rank(had, m)) best.set(m.id, id);
  }
  return Object.fromEntries(CATALOG.filter((m) => best.has(m.id)).map((m) => [m.id, best.get(m.id) as string]));
}

/**
 * The ids a kind with no list of its own (Vertex) is probed with: each allowlisted model of a maker it serves, by its
 * own id. Claude on Google Cloud has had no date suffix since the 4.6 generation (platform.claude.com, model ids and
 * versions, read 2026-10-20), and Gemini's ids are the same as on Google AI Studio.
 */
export const probeIds = (kind: ProviderKind): Available =>
  Object.fromEntries(CATALOG.filter((m) => KINDS[kind].serves.includes(m.maker)).map((m) => [m.id, m.id]));
