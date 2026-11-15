import type { BuiltinSkill } from "./index";

/**
 * How the analyst builds an App: for a job someone does, written as code the way an
 * artifact is (its own page, components and look), reading data only through the named queries its manifest declares.
 * A dashboard is one kind of screen an App may have, never the default. The look (app-design) and the code craft and
 * the runtime's API (react-app-craft) are skills of their own, read before building.
 */
export const buildAnApp: BuiltinSkill = {
  name: "build-an-app",
  title: "Build an App",
  version: 4,
  description:
    "Asked to build an App, a dashboard, a tool, a tracker or a page over their data, or to change one made in this conversation (build me a renewals desk, a support queue, add churn to it)",
  body: `An App is a small piece of software someone uses to do a job: work a queue, understand one customer, prepare a review, decide where to spend. You write it as code, the way you'd write an artifact: its own page, its own components, its own look, designed for that job. Charts are one thing a screen may hold, never the default. Its data comes only through the named queries in its manifest, so every number is real, checked and run as the person looking.

Before you plan, read /skills/opendash/app-design/SKILL.md (how a good App looks and reads, what to avoid) and /skills/opendash/react-app-craft/SKILL.md (the code: structure, responsive layout, states, and the @opendash/app API). Read them once in the conversation.

## How

0. **A reference they attach** (a sketch, a screenshot, a spec, a page they like): plan from it. Take its screens, words and layout where the data here can feed them, say in the plan's notes what you took and what this source can't do, and never copy a number off it as data.
1. **Know the job.** Who uses it, what they do with it, what they decide, how often, on what screen size. When the ask doesn't say and it matters, ask (clarify, at most three questions, options from the data). Look only as far as the plan needs: which dataset, table or service holds each thing (a few reads, one probe each where it's unclear); a broad ask gets its plan within about fifteen calls.
2. **Plan** with dashboard_plan: the purpose in one line; what it reads; each screen (a page) and, on it, the pieces in the order the person meets them, each a \`"kind": "custom"\` with a title and a one-line \`detail\` saying what it shows or lets them do ("The queue: oldest and most urgent first; pick one to work it", "The account's story: why it's at risk, in one sentence"). One screen is fine; most Apps are one to three. Say what the data can't do in \`notes\`. It ends your turn; "Build it" comes back as the next question. A small change needs no plan.
3. **Build it** on "Build it": dashboard_start first (the App is listed at once; you get its dashboard_id and base). Then write it with dashboard_save, a few files a save:
   - first the manifest (version 2: its queries and filters, no pages) and \`/App.tsx\` with the page's frame, so the person sees it take shape. \`/App.tsx\` imports only files already saved: an import of one not written yet fails the build, so keep the frame self-contained until its pieces exist;
   - then each component in \`/components\`, helpers in \`/lib\` or \`/hooks\`, rules Tailwind can't say in \`/styles.css\`;
   - change a file you've written with \`edits\` (its exact old text and the new), not by writing it again.
   Think in short steps: decide the next file, then write it. Never draft a file's code or its SQL in your thinking first: write it with the tool (the person watches each file arrive, and the check tells you what's wrong faster than thinking does), then fix what the save returns. The plan already holds the layout; don't re-plan it before each file.
   Every save builds the App and checks it (the manifest's names against the source's datasets, each new or changed dataset of the App's own run once, the code's types against each query's own columns, the rules). A named query first runs when the page draws it: app_check reports one that fails. Nothing reaches the page until it passes, but your files are kept as you wrote them: what failed comes back by file and line, and you fix exactly that with \`edits\`, never by writing the files again. A save that passed may hand back what looks generated (\`looks_generated\`): fix those with your next edits. Pass the base each save gives back.
4. **Check it** before you say it's done: call app_check (what the person's browser measured at a phone's width, beside the analyst and full width: overlaps, sideways scrolling, text cut off, empty queries, errors; and under \`speed\`, advice on queries asked in rounds that wait for each other and queries that take seconds) and fix what it finds, then call it again. A "returned no rows" finding is a fact to check, not always a fault: a list that is rightly empty stays (it measures the screen the App opens on; look at the others' code against the same rules); open it with dashboard_open and read each file once: every number comes from a query and is drawn with \`Value\`, \`Chart\` or \`DataGrid\`, every query you declared is used.
5. **Answer** in two or three lines: what it's for, what's on it, anything left out and why, and that it's a draft only they see until they publish it from its page. No numbers in the answer at all, not even a limit ("a few", not "12"): the answer's check takes any number as a figure that must come from a query, and the App shows the figures.

A small change ("rename the queue", "add churn beside MRR"): open it, read the files the change touches (dashboard_open with a path), change only those lines with \`edits\` (or the manifest with \`set\`), save. Write a file whole only when it's new or most of it changes: rewriting files for a small change is slow for the person watching and risks breaking what worked. No plan, no new App.

## The manifest

The App's data, and only that: what it reads and what its code may ask of each query. Its page is its code.

\`\`\`json
{
  "version": 2,
  "title": "Renewal desk",
  "description": "Accounts renewing in the next 90 days, the ones that need a call first, and why.",
  "filters": { "f_plan": { "kind": "select", "label": "Plan", "options": ["Starter", "Growth", "Scale"], "default": [] } },
  "queries": {
    "q_renewing": {
      "source": { "connection": "<the source's id>", "dataset": "t_renewals" },
      "select": ["account_id", "name", "plan", "mrr", "renews_on", "active_users", "active_users_before"],
      "sort": ["renews_on"],
      "filters": { "f_plan": "plan" },
      "key": "account_id",
      "rows": { "pageSizes": [50] }
    },
    "q_at_stake": {
      "source": { "connection": "<the source's id>", "dataset": "t_renewals" },
      "measures": { "mrr": ["sum", "mrr"], "accounts": ["count"] },
      "filters": { "f_plan": "plan" }
    },
    "q_usage": {
      "source": { "connection": "<the source's id>", "dataset": "usage_weekly" },
      "measures": { "active_users": ["sum", "active_users"] },
      "by": ["week:week"],
      "record": "account_id"
    }
  }
}
\`\`\`

- Ids: \`q_\`, \`f_\`, \`s_\` and a short lower-case slug; keep them when you change things.
- Each query reads one source; an App may read several of the person's sources (their connection ids are listed in this conversation), say tickets from one and accounts from another. Sample data never mixes with their own.
- A query reads rows (\`select\`; \`sort\`; \`page\`) or numbers (\`measures\`: \`["count"]\`, \`["sum", "amount"]\`, \`["avg", "x"]\`, \`["count_distinct", "x"]\`, or a dataset's \`["measure", "name"]\`; \`by\` up to four columns, a date one at a grain: \`created_at:month\`). \`where\` fixes conditions: \`[["is_test", "=", false], ["plan", "in", ["Growth", "Scale"]]]\`.
- Its output columns, which the code names (a mistyped one doesn't compile): \`select\`'s columns; each measure's name; each \`by\` column, a grain's as \`created_at_month\`.
- What its code may ask of a rows query, declared on it (the server refuses anything else):
  - \`"key": "account_id"\`: a row's key, so one record can be asked for, worked on or acted on;
  - \`"rows": { "pageSizes": [25, 50], "conditions": true, "totals": { "mrr": "sum" }, "all": true }\`: page sizes, column filters, a totals row, all rows at once (a timeline);
  - \`"search": true\`: the code may pass \`{ search }\` to look in its text columns (refused without it); a \`where\` condition from the code needs \`"conditions": true\`;
  - \`"record": "account_id"\`: drawn for the record the App shows (\`useRecord\`), and only once one is picked;
  - \`"work": { "statuses": ["To do", "Chasing", "Done"] }\`: an owner, a status, a note and a follow-up for each record, kept in OpenDash, set from the App (two to eight statuses);
  - \`"actions": [{ "id": "a_done", "label": "Move to Done", "connection": "<the MCP server's id>", "tool": "<a tool that changes things>", "arguments": { "issueIdOrKey": "{key}" }, "confirm": "Move {key} to Done?" }]\`: a change in a service from a row, confirmed by the person on OpenDash's own dialog, with their own account (at most three, each naming its row in an argument that is exactly \`"{key}"\`). Never guess an argument: read it from the service first.
  Work and actions are drawn only by \`<DataGrid>\` on that query (its owner, status, follow-up and note columns; a button on each row). A list of your own markup can't show or set them: where a queue needs work or actions, the queue is a DataGrid. Both need the query's \`key\` (or \`record\`), and a dataset that has a key.
- \`"compare": "previous_period"\` (or \`"previous_year"\`) on a query of numbers gives the period before beside it (\`q.previous\`); it needs exactly one period filter on the query. \`"drill": "q_rows"\` chooses which rows a number opens (a rows query on the same dataset; every number opens its rows anyway).
- Paging, as the server holds it: a page is 50 rows unless the query says \`"page"\`; the code's \`{ pageSize }\` may only be that size or one listed in \`rows.pageSizes\` (each 5 to 500, at most five); \`"all": true\` makes the page 500 rows when the query says no \`"page"\` of its own (a smaller \`"page"\` wins), and 500 is not everything; \`{ page }\` counts from 0; \`{ sort }\` is a selected column, \`"-mrr"\` for descending.
- A record: a query declared with \`"record"\` always takes the record the App shows (\`useRecord\`) and asks nothing until one is picked. A query with a \`"key"\` returns that one row for \`useQuery(id, { record: key })\`. Passing \`record\` to a query with neither is refused. A rows query selects its dataset's key column when the dataset has one.
- A period filter needs a \`"default"\`. \`"values": { "from": "q_list" }\` names a query that lists that filter and isn't a \`record\` query.
- Sizes: at most 60 queries, 10 filters and 12 datasets of its own; 40 files, 60,000 characters a file; .tsx, .ts and .css only, at most two folders deep.
- Filters are the App's state: a period narrows a date column (presets this_month, last_month, last_3_months, last_6_months, last_12_months, this_year, last_year, or a month like 2026-09; a window ahead, like renewals in the next 90 days, is the dataset's own SQL); a select narrows a text column (\`"options"\` when few and known, else \`"values": { "from": "q_list" }\`; never a personal column). A query says which narrow it: \`"filters": { "f_period": "created_at" }\`. The App draws them with the kit's \`<Filters />\` (react-app-craft), never its own select or date input.
- \`"summaries": { "s_week": { "queries": ["q_at_stake", "q_renewing"], "prompt": "what changed and where to look" } }\`: a written summary of those answers, drawn with \`Summary\`.

**Read anything the source has; never refuse because something "isn't a dataset".** In this order:
1. a released dataset (verified): prefer its measures, they're the verified numbers;
2. a dataset not released yet (its checks passed): read like the rest; the App's numbers from it say "Unverified";
3. any table the source has learned: write the SQL as one of the App's own datasets, \`"datasets": { "t_renewals": { "connection": "<the source's id>", "title": "Renewals", "sql": "select …", "columns": [{ "name": "account_id", "type": "number" }, …] } }\`, joins, renames and filters in its SQL. Run it with sql_query first; the save runs it once through the same checks as yours and types its columns. \`key\` only when the column tells rows apart.
4. a connected service (Jira, say) for what lives only there: one call of one of its tools that only reads, as an own dataset, \`"t_bugs": { "connection": "<the server id>", "title": "Open bugs", "service": { "tool": "searchJiraIssuesUsingJql", "arguments": { … } }, "rows": "issues", "columns": [{ "name": "key", "path": "key", "type": "string" }, …], "key": "key" }\`, after calling it with mcp_call and reading its answer. Rows, counts, sums and \`by\` a time column; at most 2,000 records a call. When what the App needs doesn't exist there yet (a Fullstory metric nobody built), you may make it with the service's tool that creates it (it may ask the person first; it's never one that deletes or overwrites), then you read what it made like anything else. How to keep a service's data live, and what to do when a copy is tempting: /skills/opendash/build-an-app/services.md, before the first service dataset.
Never invent a column. Personal data (emails, names of people) is never returned: count or filter it only.

## The code, in short

React and TypeScript with Tailwind (its colours are the workspace's theme: \`bg-surface\`, \`text-muted\`, \`border-border\`, \`bg-accent-soft\`, \`text-danger-soft-foreground\`…), imports only from its own files, \`react\` and \`@opendash/app\`:

\`\`\`tsx
import { Chart, DataGrid, useFilter, useQuery, useRecord, Value } from "@opendash/app";

export default function App() {
  const stake = useQuery("q_at_stake");
  const [picked, pick] = useRecord();
  return (
    <main className="@container mx-auto grid max-w-6xl gap-6 p-4">
      <header>…the job in a line, and the one number that matters: <Value of={stake.status === "ok" ? stake.cell(0, "mrr") : null} format="money" /></header>
      <section className="grid gap-4 @2xl:grid-cols-[320px_minmax(0,1fr)]">
        <Queue picked={picked} onPick={pick} />
        <Account id={picked} />
      </section>
    </main>
  );
}
\`\`\`

The whole API, the states every piece needs, responsive layout and a complete example App are in react-app-craft.`,
  references: [
    {
      file: "services.md",
      title: "Build an App: a connected service's data, kept live",
      body: `# A connected service's data, kept live

An App's data from a service (Fullstory, Jira, HubSpot) comes from the service each time the App is opened: each call whose answer the App uses is one of its own datasets, with that exact tool and those arguments. Never copy a call's rows into the App, and never type a number you read into its code: the App would show yesterday's numbers as today's, and nobody could see where they came from.

## When a copy is tempting
- **It took several calls.** One dataset for each call. The App's code puts their answers together, each figure through \`derive()\` so it stays traced.
- **A call needs an earlier one's answer** (an id, a next page). Make it one call if the tool can (a filter, a larger page); otherwise read the id once and write it into the second call's arguments, and say in the plan that it's fixed to that id.
- **The answer isn't rows.** Shape it with the dataset's \`rows\` (where the list is in the answer) and each column's \`path\` (where its value is in an item). Call the tool with mcp_call first and read its answer to find them.
- **The answer is too large.** Ask the service for less: its own totals or groups, a filter, fewer fields, a shorter period. At most 2,000 records a call.
- **You worked a number out yourself.** Move the arithmetic into the call (the service's own aggregation) or into \`derive()\` in the App.
- **The call failed when you ran it.** Fix the call. Never fall back to a copy without saying so.
- **The figure is your own judgment of text** (you read tickets or notes and scored or grouped them). No call returns your judgment: say plainly in the answer that this part isn't live and why, and suggest a routine if it should be redone on a schedule. What a field already says (status, owner, date, label) is not judgment: that's a column.
- **The thing the App needs doesn't exist there yet** (a metric nobody built). Make it with the service's tool that creates it, then read it like anything else (build-an-app says how).

## A service that isn't ready
A service that needs a sign-in shows no tools, so it's easy to mistake for one that isn't there. mcp_find lists every service, with its state. When the one the App needs needs a sign-in:
1. Say why you ask, in terms of what they asked for: "Your sessions are in Fullstory, which needs your sign-in before I can read them."
2. Say what else works now (another source that has some of it, or an App without that part).
3. Its Connect card ends your turn; when they're back, call it again.
If only one tool or object is refused (a permission or scope), say which and who can grant it, and use the rest.

## Who sees what
An App reads a service as its owner, with the tools an admin allowed in Apps: everyone who opens it sees the owner's answers. Say so when you build one on a person's own account, so they know who sees what before they publish it.`,
    },
  ],
};
