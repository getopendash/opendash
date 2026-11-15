import type { BuiltinSkill } from "./index";

/**
 * How an App should look and read: taste for an App the analyst writes as code, from the
 * job, never from a menu of sections. A short core (whose word wins, the job, the procedure) and references read when
 * the work needs them. The save checks the code and the data; this is what makes it good.
 */
export const appDesign: BuiltinSkill = {
  name: "app-design",
  title: "App design",
  version: 3,
  description:
    "Planning or building an App (or a dashboard, a tool, a page), or changing how one looks: whose word wins, the job, the procedure, and what to avoid",
  body: `## Whose word wins

1. What the person says in this conversation.
2. The team's own way: their skills (ls /skills: a house style, how they read an account) and their guides (grep "app" or "dashboard" in /guides). A narrower one wins over a wider one.
3. This skill.

Taste gives way; the save's rules (data only through queries, imports closed, every figure traceable) and basic accessibility never do. When the team asks for something this skill calls slop, follow the team and say so in a line.

## Start from the job, not from charts

An App is for someone doing a job. Name the person and the job before you choose anything, and let the job pick the shape:
- **A queue to work** (renewals to chase, tickets to triage): the list is the screen, the picked item beside it with what to do next; the numbers about the queue are one line above it.
- **One thing understood** (a customer, a deal, an incident): its story first (a sentence saying what matters now), then the evidence, then its history.
- **A decision:** the answer first (a sentence, a verdict, one number), what it rests on, the detail behind it, the inputs that would change it.
- **A review** (weekly, monthly): the story in order, a point per block, the period and the comparison said plainly.
- **A monitor** read at a glance: a few numbers against their normal, a trend each, what moved.

A chart earns its place by answering a question the person has; most screens need one or two, and a queue may need none. A table is often the best answer. Words are often better than both: say what the numbers mean.

A screen used daily is dense and quiet; one opened monthly carries notes that explain it.

## How

1. **Plan in three lines** before the plan you show: the shape (queue, one thing, decision, review, monitor), the one point the first screen makes, and each piece with what it does for the person. Read anti-slop.md and recipes.md, and change any line that's a default you'd write for any App.
2. **Build** with the references below as you need them.
3. **Look once** at what you built as its user would, then go through review.md. Fix every "no" in one batch; don't loop.

## Read when

- layout.md: the page's structure, hierarchy, density, and how it works at every width (the analyst open beside it, a phone).
- data.md: numbers, charts and tables: which, and how they read.
- states.md: what each piece shows while loading, empty, failed, or waiting for a pick.
- interaction.md: picking, filters, inputs, work on records, actions in a service.
- anti-slop.md: always, once, before you plan.
- recipes.md: always, before you write the first file: the list, the panes, a state, a line of numbers, the empty states.
- review.md: once, after you build.
(Each at /skills/opendash/app-design/<file>.)

## Words on the page

- A heading says what's below it in the person's words ("Accounts near their seat limit", "Who needs a call this week"), never a generic word (Overview, Insights, Key metrics, Performance, Dashboard) or a column's name.
- Notes are short, specific and true: what a threshold is, where a number comes from, what's left out and why.
- Empty is said ("Nothing to chase this week"); a missing value is "—", never 0.
- Plain words from the user's side; no filler ("a comprehensive view of…", "unlock insights", "at a glance").`,
  references: [
    {
      file: "layout.md",
      title: "App design: layout",
      body: `# Layout

## Structure follows the job
- One main thing per screen, and it's the biggest: the queue, the story, the answer.
- Reading order is the order of use: what to do first sits top left (or top, on a phone).
- Panes for work: a list beside the picked item (list about a third, never under 260px); the item's panel stays in view while the list scrolls (sticky, self-start).
- Group by meaning, with space rather than boxes: a heading and a gap separate groups; a border or a surface only where something is a distinct object (a card you pick, a panel you work in).
- Align to one grid: a few column widths, consistent gaps (Tailwind's 2, 3, 4, 6, 8), edges that line up across blocks. Uneven heights in a row read as broken: equal heights (grid rows stretch), or one tall block beside stacked short ones on purpose.

## Every width
An App is opened full width, with the analyst open beside it (about 700–800px for the App), and on a phone. It must work at all three without overlapping or cutting anything off:
- Lay out by the room the App has, not the window: a container on the page and container queries for columns (react-app-craft says how).
- Columns collapse in order of importance: the side rail first, then panes stack (the list above the item), then grids become one column.
- Nothing has a fixed width beyond a list's or rail's column; text wraps or truncates with the full text on hover; numbers never truncate.
- Long tables scroll inside themselves, not the page sideways.

## Density and hierarchy
- Type: one size for the page's title (20px), one for headings (13–14px, semibold), body 13–14px, labels 12px muted. Numbers tabular.
- Weight and colour carry hierarchy before size does: the important number semibold in the foreground colour, its label muted.
- Colour is for meaning (good, warn, bad, the accent for what's selected or the one action), never decoration. Most of the page is the surface and the foreground.`,
    },
    {
      file: "data.md",
      title: "App design: data",
      body: `# Showing data

## Numbers
- A number someone acts on is big and has a comparison: against the period before, a target, "of N", its normal. Drawn with Value, so a press opens its rows.
- Three headline numbers at most; usually one or two. Often a sentence is better: "**12** accounts renew this month; **5** need a call."
- Units and periods are said ("MRR, September", "tickets open now"). Money and percent formatted; a share as a percent.

## Charts (the Chart primitive)
Only where the shape over time or across groups is the answer. Pick by the question:
- change over time: line (one to four series) or bar by month or week; area for a total made of parts;
- comparing groups: bar, lying down when the labels are long, ranked when order matters (top);
- parts of a whole: a stacked bar or a treemap, never a pie of many slices;
- two numbers per thing: scatter;
- against a goal: bullet; a funnel's stages: funnel; a daily rhythm: calendar; spans: timeline; spread: boxplot; flows: sankey; a pattern across two groupings: heatmap.
What each needs from its query (a shape it can't read draws "Nothing to draw", and no save catches it):
- line, bar, area: \`x\` a group or a date at a grain, \`y\` the numbers; \`series\` a column that splits one number;
- scatter: \`x\` and \`y[0]\` two numbers, \`label\` the thing each dot is;
- bullet: \`y[0]\` and \`target\` (a number or a column); \`x\` when there are several;
- calendar: \`x\` a day, \`y[0]\`;
- funnel: \`x\` the stage column, \`stages\` the stages' names in order (it draws nothing without them), \`y[0]\`;
- treemap: the query's own \`by\` (one column or two), \`y[0]\`;
- waterfall: \`x\` a date at a grain, \`y[0]\` the level;
- heatmap: \`x\` across, \`series\` down, \`y[0]\`;
- sankey: \`x\` from, \`series\` to, \`y[0]\`;
- timeline: a rows query, \`x\` the label, \`y\` the start and the end column;
- boxplot: a rows query, \`x\` the group, \`y[0]\`.
Timeline and boxplot read rows, so their query says \`"rows": { "all": true }\` and no smaller \`"page"\`, or only its first page (50 rows) is drawn.
Never two y-axes; at most six coloured series; a title that says the point, not the measure ("Sign-ups slowed after June", not "Sign-ups").

## Tables (the DataGrid primitive, or your own list)
- The DataGrid for many rows people sort, filter and page; your own list when each row is an item to pick or work (two lines, the key fact right-aligned, a status as a dot and a word, recipes.md).
- Columns: the identifying one first, numbers right-aligned, at most seven; a status as a dot and a word in its tone (good, warn, bad).
- Every row of a queue says why it's there ("renews in 12 days, usage down 30%").`,
    },
    {
      file: "states.md",
      title: "App design: states",
      body: `# States: every piece, every time

Each piece that reads a query draws all of these; none is ever blank or stuck:
- **Loading:** a skeleton the size and shape of what's coming (rows as bars, a chart as its box), after a beat (never a spinner for the whole page). A previous answer stays, dimmed, while the next loads.
- **Empty:** say so in a sentence that tells them what it means ("No renewals in the next 90 days"), in the piece's own space.
- **Failed:** say what failed in a line and offer Try again (the result's retry); the rest of the App keeps working.
- **Waiting for a pick:** the panel says what to do ("Pick an account to see its story"), the size of what will come.
- **Partial:** when a query has more rows than drawn, say so ("The first 50 of 312").
Charts and DataGrids draw their own states; your components draw theirs (react-app-craft has the pattern).`,
    },
    {
      file: "interaction.md",
      title: "App design: interaction",
      body: `# Interaction

- **Picking:** pressing an item in a list shows it beside the list (useRecord keeps it in the page's address, so a link opens it; or component state when it needn't be shared). The picked item is marked (the accent's soft surface and border).
- **Filters:** the App's filters as its own controls, in one row above what they narrow, only the ones this screen's queries use; a period as a few named presets.
- **Inputs (what-ifs):** a slider or a number field next to what it changes, its value said; the result updates as it moves. Keep the input's number in \`useState\` and use it inside \`derive()\`'s function; \`useAssumption\` declares a fixed number and has no setter.
- **Work on records** (a query declaring work): owner, status, note and follow-up, saved as they change. They are the DataGrid's columns on that query: a list of your own markup can't show or set them.
- **Actions in a service** (a query declaring actions): a button on each row of that query's DataGrid; OpenDash's own dialog shows exactly what will be sent and the person confirms; never a silent change.
- **Keyboard:** everything pressable is a \`button\` (an App has no links), reachable by Tab, with a visible focus ring; a list moves with the arrow keys when it's the main thing.
- **Feedback:** a press shows its result where the person is looking; nothing changes elsewhere without telling them.`,
    },
    {
      file: "anti-slop.md",
      title: "App design: what to avoid",
      body: `# What makes an App look generated

An App is a working tool, used every day. The bar is a tool like Linear, Attio or Stripe's dashboard: dense, calm, hairlines, one accent. Each line: don't → do. Build from recipes.md; don't invent containers.

## Never
- A coloured stripe on one edge of a row, card or note (border-l-4, border-l-danger) → rows in a divide-y list; a tone as a dot and a word.
- A box inside a box (a bordered or tinted block inside a card or panel) → one container; its sections separated by space and a heading.
- An eyebrow: a small UPPERCASE, letter-spaced label above a heading ("WHY THEY'RE HERE") → a heading in sentence case, text-sm font-semibold.
- A ring, donut or gauge for one number → the number in text with its comparison; a thin bar only when the scale matters.
- Tailwind's own colours (red-500, emerald-600, slate-*) → the theme's tokens only.
- Gradients, glows, coloured shadows, backdrop-blur, shadow-md and up → hairlines (border-border); elevation only on what floats (a popover).
- Big soft corners (rounded-xl and up, rounded-full on anything but a dot or an avatar) → rounded-md on fields and buttons; panes and lists square.

## Shape
- The page is panes, not cards: a list beside the picked item, divided by a hairline (border-l border-border), not two floating cards.
- One container level. Group by space and a heading; a border only around something you pick or a pane you work in.
- Dense: the page p-4, rows px-3 py-2 (one or two lines), a panel p-4, controls h-8, gap-2 or gap-3 inside a group, gap-6 between groups.
- Height follows content: no fixed heights or min-h on panels, no empty space to fill a column.
- Left-aligned; numbers right-aligned and tabular-nums.

## Colour
- Most of the page is surface, foreground, muted and border. Colour marks only what needs action, or what's selected.
- A state is a small dot in its tone and a word in text-{tone}-soft-foreground: never a pill, never a tinted row, never a big coloured number.
- Healthy or normal isn't coloured: no green on every good row.
- Accent: the selected row (bg-accent-soft) and the one primary action (bg-accent). Accent text is text-accent-soft-foreground, never text-accent.
- Colour is never the only signal: the word is always there.

## Numbers
- Each fact once: a number, or a word, or a bar; not two of them for the same thing (93, "Healthy" and a ring).
- No hero numbers on rows: a row's number is text-sm, like its name.
- At most three headline numbers, in one line (a dl: text-sm label, a semibold value), or a sentence.

## Type
- Two sizes do most of the work: text-sm for content, text-xs muted for what's about it. The page's title text-lg font-semibold; headings text-sm font-semibold.
- No uppercase but abbreviations; no letter-spacing utilities.
- Weight before size, size before colour.

## Also generated
- Charts on every screen, a grid of metric tiles, a grid of identical cards → the job's shape (a queue, a story, an answer).
- Icons or emoji beside every heading, sparkle icons, tinted "AI" boxes → words; an icon only where it says what a word can't.
- Generic headings (Overview, Insights, Key metrics) → what the block shows.
- Dashed placeholder boxes, a centred "Select an item" card → one muted line where the content will be.
- transition-all, hover:scale, pulsing dots → a colour change on hover.
- Invented or sample numbers, filler copy → every figure from a query; say the thing.`,
    },
    {
      file: "recipes.md",
      title: "App design: recipes",
      body: `# Recipes: the pieces Apps keep needing

In the theme's tokens, dense and calm. Copy and adapt; they follow anti-slop.md.

## A state, without a badge
\`\`\`tsx
const TONES = {
  danger: ["bg-danger", "text-danger-soft-foreground"],
  warning: ["bg-warning", "text-warning-soft-foreground"],
  success: ["bg-success", "text-success-soft-foreground"],
  neutral: ["bg-muted", "text-muted"],
} as const;

export function State({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  const [dot, text] = TONES[tone];
  return (
    <span className={"inline-flex items-center gap-1.5 whitespace-nowrap text-xs " + text}>
      <span aria-hidden className={"size-1.5 shrink-0 rounded-full " + dot} />
      {children}
    </span>
  );
}
\`\`\`

## A list to work (a queue): one row a decision
\`\`\`tsx
<ul aria-label="Accounts to call" className="divide-y divide-border border-y border-border">
  {q.rows.map((row, i) => {
    const on = picked === row.account_id;
    return (
      <li key={String(row.account_id)}>
        <button
          type="button"
          aria-current={on ? "true" : undefined}
          onClick={() => pick(row.account_id as string | number)}
          className={
            "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 text-left text-sm hover:bg-surface-secondary " +
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent " +
            (on ? "bg-accent-soft" : "")
          }
        >
          <span className="min-w-0">
            <span className="block truncate font-medium" title={String(row.name)}>{String(row.name)}</span>
            <span className="block truncate text-xs text-muted">{reasonOf(row)}</span>
          </span>
          <span className="grid justify-items-end gap-0.5 tabular-nums">
            <Value of={q.cell(i, "mrr")} format="money" />
            {row.risk === "high" ? <State tone="danger">At risk</State> : null}
          </span>
        </button>
      </li>
    );
  })}
</ul>
\`\`\`

## The list and the picked item, as panes (no cards)
\`\`\`tsx
<section className="grid border-y border-border @2xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)] @2xl:divide-x @2xl:divide-border">
  <div className="max-h-[36rem] min-w-0 overflow-y-auto">{/* the list, without its own border-y */}</div>
  <aside aria-label="Account" className="min-w-0 self-start p-4 @2xl:sticky @2xl:top-0">
    <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="truncate text-base font-semibold">{name}</h2>
      <State tone="danger">At risk</State>
    </header>
    <p className="mt-1 text-sm text-muted">Renews in 12 days · usage down since September</p>
    <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-muted">Health</dt>
      <dd className="tabular-nums"><Value of={health} /></dd>
      <dt className="text-muted">MRR</dt>
      <dd className="tabular-nums"><Value of={mrr} format="money" /></dd>
    </dl>
    <section className="mt-6 grid gap-1">
      <h3 className="text-sm font-semibold">Why they're here</h3>
      <p className="text-sm">{reason}</p>
    </section>
  </aside>
</section>
\`\`\`

## A line of numbers about the page
\`\`\`tsx
<dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
  <div className="flex items-baseline gap-2">
    <dt className="text-muted">Renewing in 90 days</dt>
    <dd className="font-semibold tabular-nums"><Value of={renewing} /></dd>
  </div>
  <div className="flex items-baseline gap-2">
    <dt className="text-muted">MRR at stake</dt>
    <dd className="font-semibold tabular-nums"><Value of={atStake} format="money" /></dd>
  </div>
</dl>
\`\`\`
Or a sentence: "12 accounts renew this month; 5 need a call", each number a Value.

## The page's header, and a section's heading
\`\`\`tsx
<header className="flex flex-wrap items-center justify-between gap-3">
  <div className="min-w-0">
    <h1 className="truncate text-lg font-semibold">Renewal desk</h1>
    <p className="text-sm text-muted">Accounts renewing in the next 90 days, the ones to call first.</p>
  </div>
  <Filters />
</header>

<section className="grid gap-2">
  <h2 className="text-sm font-semibold">Accounts near their seat limit</h2>
  {/* … */}
</section>
\`\`\`

## A button (32px)
\`\`\`tsx
<button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-accent">Export</button>
<button type="button" className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90">Log call</button>
\`\`\`

## Empty, waiting and loading: in the piece's own space, no box, no dashed border
\`\`\`tsx
<p className="px-3 py-6 text-sm text-muted">Nothing to chase this week. Renewals inside 90 days appear here.</p>
<p className="p-4 text-sm text-muted">Pick an account to see why it's here and what to say.</p>
<ul aria-busy="true" className="divide-y divide-border border-y border-border">
  {Array.from({ length: 8 }, (_, i) => (
    <li key={i} className="grid gap-1.5 px-3 py-2.5">
      <span className="h-3 w-2/5 animate-pulse rounded-sm bg-surface-secondary" />
      <span className="h-2.5 w-3/5 animate-pulse rounded-sm bg-surface-secondary" />
    </li>
  ))}
</ul>
\`\`\``,
    },
    {
      file: "review.md",
      title: "App design: review",
      body: `# Review: once, after you build

Read each file once, then the App as its user would. Each is a yes or a no; fix every no in one batch, then answer.

1. The first screen does the job's first step (works the queue, tells the story, gives the answer) without scrolling.
2. It isn't a grid of charts: every chart answers a question the person has.
3. Every heading says what's below it; none is generic.
4. Every number comes from a query and is drawn with Value (or a Chart or DataGrid); every headline number has a comparison.
5. Every piece draws loading, empty, failed and waiting states.
6. At the width with the analyst open (about 760px) and at a phone's (390px), nothing overlaps, nothing is cut off, nothing scrolls sideways; panes stack in order of importance.
7. Rows line up: equal heights side by side, one grid of gaps.
8. Colour means something everywhere it's used; one accent.
9. Everything pressable works with a keyboard and has a visible focus.
10. Every query in the manifest is used, and only the filters a screen's queries take are on it.
11. Nothing on anti-slop.md's "Never" list is on the page, and every container is one level deep.
12. Each screen asks for its queries once: no piece waits for another query's rows when it needs only the record's key or a filter's value, and app_check's \`speed\` is empty or explained.`,
    },
  ],
};
