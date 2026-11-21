// A workspace's connected services as one real workspace has them, by shape only (made-up services and tools): three
// servers with 18, 40 and 98 tools, named in camelCase, snake_case and kebab-case, with descriptions of about a
// thousand characters and inputs of about two thousand, and a fourth turned on that nobody has signed in to yet, so it
// has no tools listed.

export interface FixtureTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface FixtureServer {
  name: string;
  /** The slug its made-up address ends in. */
  slug: string;
  auth: "none" | "oauth";
  tools: FixtureTool[];
}

const READS = { readOnlyHint: true };
/** Adds, never deletes or overwrites: asks the person first. */
const ADDS = { readOnlyHint: false, destructiveHint: false };
/** Says it may delete or overwrite: never called. */
const DELETES = { readOnlyHint: false, destructiveHint: true };
/** Doesn't say it only reads, or that it doesn't overwrite: taken as one that may (MCP's default). */
const UNSAID = {};

// What most real descriptions go on to say after their first sentence: how paging, times and errors work.
const PAGING =
  "Results come back newest first, at most 50 at a time: pass the cursor the last page ended with to read the next one, and stop when there is none. Times are ISO 8601 in UTC; leave out from and to for the last 7 days. Every identifier is the one the service shows in its own links and exports, never a display name.";
const FIELDS =
  "Ask only for the fields you need: a large payload is slow, and one over 2 MB is refused with a message saying so. A record the account can't see is left out without a word, so a short page doesn't mean there are no more.";
const ERRORS =
  "Errors come back as a message with a code. A 429 means the account made too many requests: wait a minute before calling again. A 403 names the permission the account is missing, which an administrator of the service can grant.";

const text = (first: string, more = "") => [first, more, PAGING, FIELDS, ERRORS].filter(Boolean).join("\n\n");

/** What most real inputs also take: where to read from, how to read it, and what to say back. */
const OPTIONS = {
  workspace: {
    type: "string",
    description:
      "Which of the account's workspaces to read, by its id. Leave out for the account's default one; an id the account can't see is refused.",
  },
  time_zone: {
    type: "string",
    default: "UTC",
    description:
      "The IANA time zone that days and weeks are counted in, such as Europe/Berlin. Times sent back stay in UTC.",
  },
  include_archived: {
    type: "boolean",
    default: false,
    description: "Whether records that were archived are included too. They are read-only and marked archived.",
  },
  format: {
    type: "string",
    enum: ["json", "markdown"],
    default: "json",
    description: "json returns structured records; markdown returns a table meant for people, with fewer fields.",
  },
};

const listInput = (thing: string, filters: Record<string, unknown> = {}) => ({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    cursor: {
      type: "string",
      description: "Where the previous page ended, exactly as it said. Leave out for the first page.",
    },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50, description: `How many ${thing} at most.` },
    from: { type: "string", format: "date-time", description: "The earliest time to include, ISO 8601 in UTC." },
    to: { type: "string", format: "date-time", description: "The latest time to include, ISO 8601 in UTC." },
    order: { type: "string", enum: ["newest", "oldest"], default: "newest", description: "Which come first." },
    fields: {
      type: "array",
      items: { type: "string" },
      description: `Only these fields of each of the ${thing}. Leave out for the usual ones; "*" for every field.`,
    },
    filter: {
      type: "object",
      description: `Narrows the ${thing}: every condition given must hold.`,
      properties: {
        owner: { type: "string", description: "The owner's id, as the service shows it." },
        tag: { type: "array", items: { type: "string" }, description: "Any of these tags." },
        ...filters,
      },
      additionalProperties: false,
    },
    ...OPTIONS,
  },
  additionalProperties: false,
});

const oneInput = (thing: string, extra: Record<string, unknown> = {}, required: string[] = ["id"]) => ({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    id: { type: "string", description: `The ${thing}'s id or key, as the service shows it in its links.` },
    fields: {
      type: "array",
      items: { type: "string" },
      description: `Only these fields of the ${thing}. Leave out for the usual ones; "*" for every field.`,
    },
    expand: {
      type: "array",
      items: { type: "string", enum: ["history", "links", "owner", "children"] },
      description: "Related records to include with it, each read with the same account.",
    },
    ...extra,
    ...OPTIONS,
  },
  required,
  additionalProperties: false,
});

const tool = (
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, unknown>,
  annotations: FixtureTool["annotations"] = READS,
): FixtureTool => ({ name, title, description, inputSchema, annotations });

/** An observability service for model calls: camelCase names, one with an acronym, one named just `search`. */
const observability: FixtureTool[] = [
  tool(
    "getTraceCosts",
    "Trace costs",
    text("Returns what LLM calls cost, per trace, grouped by model, user or tag, in US dollars."),
    listInput("cost rows", { group_by: { type: "string", enum: ["model", "user", "tag"] } }),
  ),
  tool(
    "getLLMUsage",
    "LLM usage",
    text("Token counts of LLM calls, by model and day."),
    listInput("days", { model: { type: "string" } }),
  ),
  tool("listTraces", "Traces", text("Lists traces, newest first."), listInput("traces")),
  tool("getTrace", "Trace", text("One trace with its spans, inputs and outputs."), oneInput("trace")),
  tool(
    "searchTraces",
    "Search traces",
    text("Finds traces whose input or output has the words given."),
    listInput("traces", { text: { type: "string" } }),
  ),
  tool("deleteTrace", "Delete a trace", text("Deletes a trace and its spans for good."), oneInput("trace"), DELETES),
  tool("listSpans", "Spans", text("Lists the spans of a trace."), listInput("spans")),
  tool("listPrompts", "Prompts", text("Lists the prompt templates and their versions."), listInput("prompts")),
  tool("getPrompt", "Prompt", text("One prompt template, at a version."), oneInput("prompt")),
  tool("listScores", "Scores", text("Lists the evaluation scores given to traces."), listInput("scores")),
  tool("listDatasets", "Datasets", text("Lists the datasets of examples."), listInput("datasets")),
  tool("getDataset", "Dataset", text("One dataset with its examples."), oneInput("dataset")),
  tool("listComments", "Comments on traces", text("Lists the comments people left on traces."), listInput("comments")),
  tool("getModelPrices", "Model prices", text("The price per thousand tokens of each model."), listInput("models")),
  tool("listUsers", "Users", text("Lists the end users seen in traces."), listInput("users")),
  tool("getMetricsDaily", "Daily metrics", text("Daily totals of traces, tokens and latency."), listInput("days")),
  tool(
    "search",
    "Search",
    text("Searches everything: traces, prompts and datasets."),
    listInput("results", { text: { type: "string" } }),
  ),
  tool("getHealth", "Health", text("Whether the service is up."), { type: "object", properties: {} }),
];

/** A session-replay service: snake_case names. */
const replays: FixtureTool[] = [
  tool("list_sessions", "Sessions", text("Lists recorded sessions, newest first."), listInput("sessions")),
  tool("get_session", "Session", text("One recorded session, with its pages and device."), oneInput("session")),
  tool(
    "get_session_events",
    "Session events",
    text("Every click, page view and error in one session, in order."),
    oneInput("session"),
  ),
  tool(
    "search_sessions",
    "Search sessions",
    text("Finds sessions where people did something: visited a page, clicked, saw an error."),
    listInput("sessions", { did: { type: "string" } }),
  ),
  tool(
    "export_sessions",
    "Export sessions",
    text("Starts an export of sessions to a file."),
    listInput("sessions"),
    ADDS,
  ),
  tool("list_pages", "Pages", text("Lists the pages people visited, with how often."), listInput("pages")),
  tool("get_page_views", "Page views", text("Views of one page by day."), oneInput("page")),
  tool("list_clicks", "Clicks", text("Lists the elements people clicked most."), listInput("clicks")),
  tool(
    "get_rage_clicks",
    "Rage clicks",
    text("Where people clicked over and over in frustration."),
    listInput("clicks"),
  ),
  tool("list_errors", "Errors", text("Lists the errors people's browsers hit."), listInput("errors")),
  tool("get_error", "Error", text("One error, with the sessions that hit it."), oneInput("error")),
  tool("list_funnels", "Funnels", text("Lists the saved funnels."), listInput("funnels")),
  tool("get_funnel_steps", "Funnel steps", text("How many people reached each step of a funnel."), oneInput("funnel")),
  tool("list_segments", "Segments", text("Lists the saved segments of people."), listInput("segments")),
  tool("get_segment", "Segment", text("One segment and who is in it."), oneInput("segment")),
  tool("create_segment", "New segment", text("Saves a new segment of people."), oneInput("segment"), ADDS),
  tool(
    "update_segment",
    "Change a segment",
    text("Changes a saved segment's conditions."),
    oneInput("segment"),
    UNSAID,
  ),
  tool("delete_segment", "Delete a segment", text("Deletes a saved segment."), oneInput("segment"), DELETES),
  tool("list_users", "People", text("Lists the people who were recorded."), listInput("people")),
  tool("get_user", "Person", text("One person, with their sessions."), oneInput("person")),
  tool("list_events", "Events", text("Lists the custom events sent from the site."), listInput("events")),
  tool("count_events", "Count events", text("Counts events by name and day."), listInput("events")),
  tool("list_heatmaps", "Heatmaps", text("Lists the saved heatmaps."), listInput("heatmaps")),
  tool("get_heatmap", "Heatmap", text("One page's heatmap of clicks and scrolls."), oneInput("heatmap")),
  tool("list_notes", "Notes", text("Lists the notes people left on sessions."), listInput("notes")),
  tool("create_note", "New note", text("Leaves a note on a session."), oneInput("note"), ADDS),
  tool("list_tags", "Tags", text("Lists the tags given to sessions."), listInput("tags")),
  tool("list_devices", "Devices", text("Sessions by device type."), listInput("devices")),
  tool("get_browser_breakdown", "Browsers", text("Sessions by browser and version."), listInput("browsers")),
  tool("list_countries", "Countries", text("Sessions by country."), listInput("countries")),
  tool(
    "get_conversion_rate",
    "Conversion rate",
    text("The share of sessions that reached a goal page."),
    oneInput("goal"),
  ),
  tool(
    "list_experiments",
    "Experiments",
    text("Lists the A/B experiments running on the site."),
    listInput("experiments"),
  ),
  tool("get_experiment", "Experiment", text("One experiment's variants and results."), oneInput("experiment")),
  tool(
    "list_feature_flags",
    "Feature flags",
    text("Lists the feature flags the site reports, and who saw each."),
    listInput("flags"),
  ),
  tool("list_annotations", "Annotations", text("Lists the annotations on the timeline."), listInput("annotations")),
  tool(
    "create_annotation",
    "New annotation",
    text("Adds an annotation to the timeline."),
    oneInput("annotation"),
    ADDS,
  ),
  tool("get_retention", "Retention", text("How many people came back, by week."), listInput("weeks")),
  tool("get_active_users", "Active people", text("People active each day, week and month."), listInput("days")),
  tool("list_exports", "Exports", text("Lists the exports started, and whether each is ready."), listInput("exports")),
  tool("get_export", "Export", text("One export, with a link to its file when it's ready."), oneInput("export")),
];

// An issue tracker: kebab-case names, five for each kind of thing, and a `search` and `fetch` of its own.
const KINDS: [string, string][] = [
  ["issue", "issues"],
  ["project", "projects"],
  ["comment", "comments"],
  ["sprint", "sprints"],
  ["board", "boards"],
  ["epic", "epics"],
  ["label", "labels"],
  ["component", "components"],
  ["version", "versions"],
  ["worklog", "worklogs"],
  ["attachment", "attachments"],
  ["user", "users"],
  ["team", "teams"],
  ["workflow", "workflows"],
  ["transition", "transitions"],
  ["filter", "filters"],
  ["dashboard", "dashboards"],
  ["field", "fields"],
  ["priority", "priorities"],
  ["watcher", "watchers"],
];
/** Each issue belongs to a project, so most of the tracker's descriptions say so: a word in many of its tools. */
const IN_PROJECT = "Each one belongs to a project and is read with the account's own permissions on its issues.";
const LEFT_OUT = new Set([
  "create-transition",
  "update-transition",
  "delete-transition",
  "create-priority",
  "delete-priority",
]);
const tracker: FixtureTool[] = [
  ...KINDS.flatMap(([one, many]) => {
    const Many = many[0]?.toUpperCase() + many.slice(1);
    const One = one[0]?.toUpperCase() + one.slice(1);
    return [
      tool(`list-${many}`, Many, text(`Lists the ${many}, filtered and paged.`, IN_PROJECT), listInput(many)),
      tool(
        `get-${one}`,
        One,
        text(`Gets one ${one} by its key or id, with all its fields.`, IN_PROJECT),
        oneInput(one),
      ),
      tool(
        `create-${one}`,
        `New ${one}`,
        text(`Creates a new ${one}.`, IN_PROJECT),
        oneInput(one, { title: { type: "string", maxLength: 255 } }, ["title"]),
        ADDS,
      ),
      tool(`update-${one}`, `Change ${One}`, text(`Changes a ${one}'s fields.`, IN_PROJECT), oneInput(one), UNSAID),
      tool(`delete-${one}`, `Delete ${One}`, text(`Deletes a ${one} for good.`, IN_PROJECT), oneInput(one), DELETES),
    ].filter((t) => !LEFT_OUT.has(t.name));
  }),
  tool(
    "search-issues",
    "Search issues",
    text("Finds issues with a query in the tracker's own query language.", IN_PROJECT),
    listInput("issues", { query: { type: "string" } }),
  ),
  tool(
    "search",
    "Search",
    text("Searches every kind of record at once, by words in its title or text."),
    listInput("results", { text: { type: "string" } }),
  ),
  tool("fetch", "Fetch", text("Reads any one record by the link the service gave it."), oneInput("record")),
];

export const WORKSPACE: FixtureServer[] = [
  { name: "Observability", slug: "observability", auth: "none", tools: observability },
  { name: "Replays", slug: "replays", auth: "none", tools: replays },
  { name: "Tracker", slug: "tracker", auth: "none", tools: tracker },
  // Turned on, but each person signs in with their own account and nobody has: its tools were never listed.
  { name: "Wiki", slug: "wiki", auth: "oauth", tools: [] },
];
