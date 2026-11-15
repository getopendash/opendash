import { SUPPORT_DESK_FILES } from "@opendash/apps/examples";
import { RUNTIME_DTS } from "@opendash/apps/kit-reference";
import type { BuiltinSkill } from "./index";

/**
 * How to write an App's code well: its files, responsive layout by the room it has, every
 * state, accessibility, and the runtime's API exactly as the check types it. Responsiveness is the code's craft, taught
 * here, never a rule a kit imposes. A complete example App is a reference file, the same one the tests build.
 */
export const reactAppCraft: BuiltinSkill = {
  name: "react-app-craft",
  title: "React App craft",
  version: 4,
  description:
    "Writing or changing an App's code: its files, responsive layout, states, accessibility, and the @opendash/app API",
  body: `## Files

- \`/App.tsx\`: the page (its default export). Its frame and the order of what's on it; small.
- \`/pages/Name.tsx\`: a screen of an App with several (Today, Customers, Customer), named exports; App.tsx switches between them.
- \`/components/Name.tsx\`: one piece each (Queue, AccountPanel, RenewalChart), named exports.
- \`/lib/name.ts\` (or \`.tsx\`): helpers (formatting a duration, ranking rows); \`/hooks/useName.ts\`: a hook several pieces share.
- \`/styles.css\`: only what Tailwind can't say well (a container rule with a name, a scrollbar, a print rule). It loads nothing (no @import, no outside url()).
Imports: your own files (\`./components/Queue\`), \`react\`, and \`@opendash/app\`. Nothing else exists: no npm packages, no fetch, no storage, no \`document\`, \`location\` or \`window.parent\`, no \`dangerouslySetInnerHTML\`; and no \`<a>\`, \`<form>\`, \`<iframe>\`, \`<script>\`, \`<audio>\` or \`<video>\` (an App has no links: everything pressed is a \`button\`). The frame blocks them and the save refuses them.

## Styling

Tailwind, compiled from the classes you use. Colours are the workspace's theme and follow light and dark by themselves: \`bg-background\`, \`bg-surface\`, \`bg-surface-secondary\`, \`text-foreground\`, \`text-muted\`, \`border-border\`, \`divide-border\`, \`bg-accent\` / \`text-accent-foreground\`, \`bg-accent-soft\` / \`text-accent-soft-foreground\`, and \`success\`, \`warning\`, \`danger\` each with \`-soft\` and \`-soft-foreground\`. A tone's word is \`text-{tone}-soft-foreground\` (plain \`text-warning\` is too faint to read); accent text is \`text-accent-soft-foreground\`, never \`text-accent\`. Never a hex colour or Tailwind's own palette (\`red-500\`). Numbers: \`tabular-nums\`. How it should look, piece by piece: app-design's recipes.md.

## Responsive, by the room it has

The App is drawn full width, beside the analyst (about 700–800px), and on a phone. Lay out by its own width, not the window's:
- Put \`@container\` on the page's outer element; size columns with container variants: \`grid gap-4 @3xl:grid-cols-[320px_minmax(0,1fr)]\`, \`@xl:grid-cols-2\`, \`@5xl:grid-cols-3\`. (\`md:\`, \`lg:\` follow the window, which isn't the App's width when the analyst is open: don't use them for layout.) A list beside the picked item goes side by side from \`@2xl\` (672px), so it still does beside the analyst.
- Columns are \`minmax(0,1fr)\` (never a bare \`1fr\` that a long word can widen); fixed widths only for a list's or rail's column.
- Every grid or flex child that holds text gets \`min-w-0\`; text truncates (\`truncate\`, with \`title\` for the full text) or wraps; numbers never truncate.
- A list or table that can grow scrolls inside a bounded height (\`max-h-[32rem] overflow-y-auto\`), not the page sideways; a panel beside a list is \`self-start sticky top-4\`.
- Side by side only pieces of the same kind and about the same height (two charts, two short lists), in one grid row so they end together. A chart and a table, a short piece and a long one: one below the other, full width (a chart beside a long table leaves a gap under the chart).
- Check it in your head at 390px, 760px and 1280px before you save: what stacks, what scrolls, what truncates.

## The kit's pieces, inside your design

The App is yours: its layout, its screens, its rows and panels, its words, its look. \`@opendash/app\` also gives a few finished pieces for jobs that are hard to do well; drop one in where that job comes up, inside your own layout, and keep designing around it. They never replace the App's design, and an App is never just a stack of them.
- A control for one of the App's filters: \`<Filter id="f_period" />\` (a date range with presets and a calendar; a select's searchable picker), or \`<Filters />\` for all of them in one compact row. Use these instead of a \`<select>\` or date input of your own.
- A choice of the App's own: \`<Picker>\` (searchable, one or several: an autocomplete when there are many), \`<Select>\` for a short list, \`<Segmented>\` for two to five side by side, \`<Search>\` for a search field, \`<Tabs>\` for views under a header. Use them where you'd otherwise hand-make the same control.
- \`<DataGrid query>\` where people need a spreadsheet's power over many records (sort any column, filter, page, totals, row actions). A list you designed for the job (a call queue, a ranked list with the reason on each row) stays your own markup.
- \`<Chart>\` for a chart; \`<Value>\` for every figure from the data.
- \`<Source query="q_…" />\` under a piece you draw yourself from a query (a row of stats, a list of your own): a quiet line saying where its numbers come from ("Warehouse · Accounts", "Fullstory · Checkout funnel"). \`<Chart>\` and \`<DataGrid>\` say it under themselves already. Every piece that shows data says where it comes from.

## States, in every piece that reads a query

\`\`\`tsx
const q = useQuery("q_renewing", { pageSize: 50 });
if (q.status === "loading" && !q.rows.length) return <Loading rows={8} />; // rows as bars, the shape of what's coming (recipes.md)
if (q.status === "error") return <p className="text-sm text-danger-soft-foreground">The renewals didn't load: {q.error} <button className="underline" onClick={q.retry}>Try again</button></p>;
if (!q.rows.length) return <p className="text-sm text-muted">No renewals in the next 90 days.</p>;
\`\`\`
A newer answer loading keeps the last one (\`q.stale\`): dim it (\`opacity-60\`), don't blank it. When a refresh fails the last answer stays too, with \`q.failed\` saying why (its \`status\` is still "ok"): say so in a line with Try again (\`q.retry\`). A connected service's answer doesn't stay: its failure is \`status: "error"\` with nothing kept. When a query has more rows than one page, say so (\`q.total\`). Chart and DataGrid draw their own states.

A query declared with \`record\` asks nothing until a record is picked, and until then it is \`status: "ok"\` with no rows. So a piece drawn for a record tests the pick first, before its empty state: \`const [picked] = useRecord(); if (picked === null) return <p className="text-sm text-muted">Pick an account to see its story.</p>;\`, at the size of what will come.

## Speed: a screen asks once

An App opens as fast as its slowest query when a screen asks for everything together, and as slowly as all of them added up when each piece waits for another's answer before it asks (one real App: three rounds, ten seconds, for queries that took two together).

- A piece asks as it mounts, so mount it while its neighbours are still loading and let it draw its own loading state in its own space. The \`return <Loading />\` above belongs to the piece that query fills, never above other pieces that ask: they would wait a whole round for it.
- A piece that needs only the record's key or a filter's value takes it as a prop and asks at once. \`{account.rows.length ? <Usage picked={picked} /> : null}\` makes Usage wait for the account's rows it never reads; \`<Usage picked={picked} />\` asks beside it.
- The one round that must wait: a record picked from a list's first row (none is in the address yet) can't be asked for before the list. Everything about that record then asks together.
- A query that takes more than about two seconds is felt by everyone who opens the App. Make it cheaper where you can: a narrower default period, fewer joins, a dataset that already groups it, a page of 50 rows where 500 aren't read.
- Fewer, wider queries: several measures of one dataset under the same filters are one query (\`"measures": { "mrr": […], "accounts": […] }\`), not one each.
- A list draws a page of rows (\`pageSize\`), not thousands. Work out rankings and groupings in the query (\`sort\`, \`by\`), not in the browser. \`useMemo\` for anything derived from many rows.
- \`app_check\` says under \`speed\` how many rounds the App asked in and each slow query's time. It's advice, not a finding that must be cleared: fix what it names where you can; what has to stay (the round after a list's first row, a query you can't make cheaper), tell the person in words (which piece is slow to load and why), with no figure: the answer's check takes any number as one that must come from a query.

## Numbers

Every figure from the data is drawn with \`<Value of={q.cell(i, "column")} format="money" />\` (or a Chart or DataGrid): it formats, and a press opens the rows behind it. \`cell\` takes the row's index in \`q.rows\` (\`q.rows.map((row, i) => …)\`), never the row. \`format="percent"\` takes a fraction (0.42 draws 42%); money is drawn in dollars. Never type a number into the code, never compute one with plain arithmetic for display: \`derive()\` keeps it traced. \`format()\` is for text around a value, not for the value itself.

The save refuses what looks like typed data or a typed colour, so don't write them:
- an array of three or more numbers (\`[25, 50, 100]\`: page sizes go in the manifest's \`rows.pageSizes\`, not a \`pageSizes\` prop), or three or more objects that each hold a number as data (a layout number such as a width is fine);
- a figure in text or in a \`title\`, \`label\`, \`subtitle\`, \`hint\` or \`placeholder\`: money ("$5"), a percentage ("10%"), a number with separators ("1,000") or a decimal ("2.5"). A plain whole number ("Top 10", a year) is fine;
- a colour in a string: \`#\` and hex digits, \`rgb(\`, \`hsl(\`, \`oklch(\`. Colours are the theme's classes.

## Accessibility

Real elements: a \`button\` for anything pressed, \`nav\`/\`main\`/\`aside\`/\`section\` with a heading each, a list as \`ul\` or a \`nav\` of buttons, \`aria-current\` on the picked item, \`aria-busy\` while loading. A visible focus (\`focus-visible:outline-2 focus-visible:outline-accent\`). Colour is never the only signal: a status has its word.

## The API

The second module is what you import; the first holds the shapes it names (a result's fields, the formats, a what-if's units).

\`\`\`ts
${RUNTIME_DTS.trim()}
\`\`\`

A complete App, the way a good one is written: /skills/opendash/react-app-craft/example.md.`,
  references: [
    {
      file: "example.md",
      title: "React App craft: a complete App",
      body: `# A support desk

A queue to work (open tickets, oldest first), the picked ticket beside it, the week's volume, every ticket in a grid. Responsive by its own container rule: the queue and the ticket side by side when there's room, one above the other when there isn't. Every figure from a query; the two primitives where they fit.

${Object.entries(SUPPORT_DESK_FILES)
  .map(([file, source]) => `## ${file}\n\n\`\`\`${file.endsWith(".css") ? "css" : "tsx"}\n${source.trim()}\n\`\`\``)
  .join("\n\n")}
`,
    },
  ],
};
