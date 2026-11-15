/**
 * The kinds of provider a workspace can connect, one entry each: how it's labelled and billed, which
 * makers' models it can run, what its credentials are, and what Settings shows of them. A workspace holds at most one
 * provider of each kind. Adding a kind is an entry here, a builder (packages/agent/src/providers) and a migration
 * line for the database check, nothing else.
 *
 * Credentials are checked here, once, before anything is stored: every field a kind needs is filled, so no SDK ever
 * falls back to the deployment's environment (AI_GATEWAY_API_KEY, OPENROUTER_API_KEY, AWS_*, GOOGLE_VERTEX_*, or
 * Google's default login) for a workspace's calls. No kind takes a base URL.
 */
import { z } from "zod";
import type { Maker } from "./catalog";

export const PROVIDER_KINDS = [
  "opendash",
  "gateway",
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "bedrock",
  "vertex",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const isProviderKind = (v: unknown): v is ProviderKind => PROVIDER_KINDS.includes(v as ProviderKind);

/** A form field of a kind's credentials, as Settings shows it. */
export interface CredentialField {
  name: string;
  label: string;
  /** Sealed, and never shown again once saved. */
  secret: boolean;
  input: "text" | "password" | "textarea" | "select";
  optional?: boolean;
  placeholder?: string;
  hint?: string;
  /** A select's choices. */
  options?: readonly { id: string; label: string }[];
  /** Shown only with this way of signing in (Bedrock's access keys or API key). */
  mode?: string;
  /** Half the form's width, beside the next field. */
  half?: boolean;
}

export interface KindInfo {
  id: ProviderKind;
  label: string;
  /** Its name where room is short (the composer's model button): "Bedrock". */
  short: string;
  /** Two letters for its mark in lists (OpenDash has its own). */
  mono: string;
  group: "opendash" | "gateways" | "makers" | "clouds";
  blurb: string;
  /** Who pays for its calls. */
  billing: string;
  /** The same, short, for a table's "Billed to". */
  billedTo: string;
  /** Ways of signing in, when there's more than one; each field says which it belongs to. */
  modes?: readonly { id: string; label: string }[];
  /** Whose models it can run. */
  serves: readonly Maker[];
  /**
   * How its models are found: its own list (`list`), a tiny call to each allowlisted one (`probe`, where a provider
   * has no list that says what this account can run), or the deployment's keys (`deployment`, OpenDash's own).
   */
  models: "list" | "probe" | "deployment";
  fields: readonly CredentialField[];
  /** Where to get the credentials, in one line. */
  hint?: string;
}

const ALL: readonly Maker[] = ["anthropic", "openai", "google"];

/** AWS's commercial regions (China, GovCloud and the isolated ones have other endpoints). */
export const BEDROCK_REGIONS: readonly { id: string; label: string }[] = [
  ["us-east-1", "N. Virginia"],
  ["us-east-2", "Ohio"],
  ["us-west-2", "Oregon"],
  ["ca-central-1", "Canada"],
  ["sa-east-1", "São Paulo"],
  ["eu-central-1", "Frankfurt"],
  ["eu-central-2", "Zurich"],
  ["eu-west-1", "Ireland"],
  ["eu-west-2", "London"],
  ["eu-west-3", "Paris"],
  ["eu-north-1", "Stockholm"],
  ["eu-south-1", "Milan"],
  ["eu-south-2", "Spain"],
  ["ap-northeast-1", "Tokyo"],
  ["ap-northeast-2", "Seoul"],
  ["ap-northeast-3", "Osaka"],
  ["ap-south-1", "Mumbai"],
  ["ap-south-2", "Hyderabad"],
  ["ap-southeast-1", "Singapore"],
  ["ap-southeast-2", "Sydney"],
  ["ap-southeast-4", "Melbourne"],
  ["me-central-1", "UAE"],
  ["il-central-1", "Tel Aviv"],
].map(([id, city]) => ({ id: id as string, label: `${id} (${city})` }));

/** Google Cloud's locations for Vertex AI's Claude and Gemini models: global, the multi-regions, and the regions. */
export const VERTEX_LOCATIONS: readonly { id: string; label: string }[] = [
  ["global", "Global"],
  ["us", "United States, multi-region"],
  ["eu", "Europe, multi-region"],
  ["us-central1", "Iowa"],
  ["us-east1", "South Carolina"],
  ["us-east4", "N. Virginia"],
  ["us-east5", "Columbus"],
  ["us-west1", "Oregon"],
  ["europe-west1", "Belgium"],
  ["europe-west2", "London"],
  ["europe-west3", "Frankfurt"],
  ["europe-west4", "Netherlands"],
  ["europe-north1", "Finland"],
  ["asia-northeast1", "Tokyo"],
  ["asia-southeast1", "Singapore"],
  ["australia-southeast1", "Sydney"],
].map(([id, place]) => ({ id: id as string, label: `${id} (${place})` }));
const apiKeyField = (hint: string): CredentialField => ({
  name: "apiKey",
  label: "API key",
  secret: true,
  input: "password",
  hint,
});

export const KINDS: Record<ProviderKind, KindInfo> = {
  opendash: {
    id: "opendash",
    label: "OpenDash",
    short: "OpenDash",
    mono: "Vi",
    group: "opendash",
    blurb: "Built in.",
    billing: "Calls are on OpenDash",
    billedTo: "OpenDash",
    serves: ALL,
    models: "deployment",
    fields: [],
  },
  gateway: {
    id: "gateway",
    label: "Vercel AI Gateway",
    short: "AI Gateway",
    mono: "GW",
    group: "gateways",
    blurb: "Every allowed model with one key.",
    billing: "Billed to your Vercel team",
    billedTo: "Your Vercel team",
    serves: ALL,
    models: "list",
    fields: [apiKeyField("From your Vercel dashboard, under AI Gateway → API keys.")],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    short: "OpenRouter",
    mono: "OR",
    group: "gateways",
    blurb: "Every allowed model with one key.",
    billing: "Billed to your OpenRouter account",
    billedTo: "Your OpenRouter account",
    serves: ALL,
    models: "list",
    fields: [apiKeyField("From openrouter.ai, under Keys.")],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    short: "Anthropic",
    mono: "An",
    group: "makers",
    blurb: "Claude models, on your own Anthropic account.",
    billing: "Billed to your Anthropic account",
    billedTo: "Your Anthropic account",
    serves: ["anthropic"],
    models: "list",
    fields: [apiKeyField("From the Claude Console, under API keys.")],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    short: "OpenAI",
    mono: "Op",
    group: "makers",
    blurb: "GPT models, on your own OpenAI account.",
    billing: "Billed to your OpenAI account",
    billedTo: "Your OpenAI account",
    serves: ["openai"],
    models: "list",
    fields: [apiKeyField("From the OpenAI platform, under API keys.")],
  },
  google: {
    id: "google",
    label: "Google Gemini",
    short: "Gemini",
    mono: "Ge",
    group: "makers",
    blurb: "Gemini models, with a Google AI Studio key.",
    billing: "Billed to your Google AI Studio project",
    billedTo: "Your AI Studio project",
    serves: ["google"],
    models: "list",
    fields: [apiKeyField("From Google AI Studio, under API keys.")],
  },
  bedrock: {
    id: "bedrock",
    label: "Amazon Bedrock",
    short: "Bedrock",
    mono: "Br",
    group: "clouds",
    blurb: "Claude in your AWS account, in the region you choose.",
    billing: "Billed to your AWS account",
    billedTo: "Your AWS account",
    serves: ["anthropic"],
    models: "list",
    modes: [
      { id: "keys", label: "Access keys" },
      { id: "apiKey", label: "Bedrock API key" },
    ],
    fields: [
      { name: "accessKeyId", label: "Access key ID", secret: true, input: "text", mode: "keys" },
      { name: "secretAccessKey", label: "Secret access key", secret: true, input: "password", mode: "keys" },
      {
        name: "sessionToken",
        label: "Session token",
        secret: true,
        input: "password",
        optional: true,
        mode: "keys",
        hint: "For temporary credentials.",
      },
      { name: "apiKey", label: "Bedrock API key", secret: true, input: "password", mode: "apiKey" },
      {
        name: "region",
        label: "Region",
        secret: false,
        input: "select",
        options: BEDROCK_REGIONS,
        hint: "Calls and data stay in this region.",
      },
    ],
    hint: "The IAM user or role needs bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream and bedrock:ListInferenceProfiles.",
  },
  vertex: {
    id: "vertex",
    label: "Google Vertex AI",
    short: "Vertex AI",
    mono: "Vx",
    group: "clouds",
    blurb: "Claude and Gemini in your Google Cloud project.",
    billing: "Billed to your Google Cloud project",
    billedTo: "Your Google Cloud project",
    serves: ["anthropic", "google"],
    models: "probe",
    fields: [
      { name: "project", label: "Project ID", secret: false, input: "text", placeholder: "acme-analytics", half: true },
      { name: "location", label: "Location", secret: false, input: "select", options: VERTEX_LOCATIONS, half: true },
      {
        name: "serviceAccount",
        label: "Service account key",
        secret: true,
        input: "textarea",
        hint: "Paste the JSON, or drop the .json file here. A service account with the Vertex AI User role.",
      },
    ],
  },
};

/** The kinds in the order Settings lists them. */
export const KIND_ORDER: readonly ProviderKind[] = PROVIDER_KINDS;

const apiKey = z
  .string()
  .trim()
  .min(20, "That doesn't look like an API key: paste the whole key.")
  .max(400, "That doesn't look like an API key: paste the whole key.")
  .regex(/^\S+$/, "That doesn't look like an API key: paste it with no spaces.");

/** A commercial AWS region (not China, GovCloud or the isolated ones, whose endpoints differ). */
const awsRegion = z
  .string()
  .trim()
  .regex(/^(us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-\d$/, "Enter an AWS region, like eu-central-1.");

const awsKeyId = z
  .string()
  .trim()
  .regex(/^(AKIA|ASIA)[A-Z0-9]{12,124}$/, "That doesn't look like an access key ID: it starts with AKIA or ASIA.");
const awsSecret = z
  .string()
  .trim()
  .min(30, "Paste the whole secret access key.")
  .max(128, "Paste the whole secret access key.");

const bedrock = z.union([
  z.object({
    region: awsRegion,
    accessKeyId: awsKeyId,
    secretAccessKey: awsSecret,
    sessionToken: z.string().trim().min(1).max(4096).optional(),
  }),
  z.object({ region: awsRegion, apiKey: z.string().trim().min(20).max(4096).regex(/^\S+$/) }),
]);

const serviceAccount = z
  .string()
  .trim()
  .max(16_384, "That's too long for a service account key.")
  .transform((text, ctx) => {
    try {
      const key = JSON.parse(text) as Record<string, unknown>;
      if (
        key.type === "service_account" &&
        typeof key.client_email === "string" &&
        typeof key.private_key === "string" &&
        key.private_key.includes("PRIVATE KEY")
      ) {
        return { client_email: key.client_email, private_key: key.private_key };
      }
    } catch {}
    ctx.addIssue({ code: "custom", message: "Paste the service account's JSON key file, as Google gave it." });
    return z.NEVER;
  });

const vertex = z.object({
  project: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "Enter the project ID, like acme-analytics."),
  location: z
    .string()
    .trim()
    .regex(/^(global|eu|us|[a-z]+-[a-z]+\d+)$/, "Enter a location, like europe-west4 or global."),
  serviceAccount,
});

const keyOnly = z.object({ apiKey });

/** What each kind's credentials are, checked. OpenDash has none. */
export const CREDENTIALS = {
  opendash: z.object({}).strict(),
  gateway: keyOnly,
  openrouter: keyOnly,
  anthropic: keyOnly,
  openai: keyOnly,
  google: keyOnly,
  bedrock,
  vertex,
} as const;

export type Credentials<K extends ProviderKind = ProviderKind> = z.output<(typeof CREDENTIALS)[K]>;

export type BedrockCredentials = Credentials<"bedrock">;
export type VertexCredentials = Credentials<"vertex">;

/** The first problem with a kind's credentials as a person typed them, or the credentials, checked. */
export function checkCredentials<K extends ProviderKind>(
  kind: K,
  input: unknown,
): { ok: true; credentials: Credentials<K> } | { ok: false; message: string } {
  const raw = blanksDropped(input);
  const parsed = CREDENTIALS[kind].safeParse(raw);
  if (parsed.success) return { ok: true, credentials: parsed.data as Credentials<K> };
  if (kind === "bedrock" && raw && typeof raw === "object" && !("apiKey" in raw) && !("accessKeyId" in raw)) {
    return { ok: false, message: "Enter an access key ID and secret, or a Bedrock API key." };
  }
  return { ok: false, message: firstMessage(parsed.error) };
}

/** Empty fields count as not given, so an optional one left blank isn't an error and a required one is. */
function blanksDropped(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => !(typeof v === "string" && v.trim() === "") && v !== undefined),
  );
}

function firstMessage(error: z.ZodError): string {
  for (const issue of error.issues) {
    if (issue.code === "invalid_union") {
      const inner = issue.errors.flat()[0];
      if (inner) return inner.message;
    }
    if (issue.message && !issue.message.startsWith("Invalid input")) return issue.message;
  }
  return "Some of these settings are missing or don't look right.";
}

const ending = (s: string) => `…${s.slice(-4)}`;

/** What Settings shows of a provider's credentials: never a secret, only enough to tell which one it is. */
export function shownOf(kind: ProviderKind, credentials: Credentials): Record<string, string> {
  if (kind === "bedrock") {
    const c = credentials as BedrockCredentials;
    return { region: c.region, key: "accessKeyId" in c ? ending(c.accessKeyId) : ending(c.apiKey) };
  }
  if (kind === "vertex") {
    const c = credentials as VertexCredentials;
    return { project: c.project, location: c.location, account: c.serviceAccount.client_email };
  }
  if (kind === "opendash") return {};
  return { key: ending((credentials as Credentials<"anthropic">).apiKey) };
}
