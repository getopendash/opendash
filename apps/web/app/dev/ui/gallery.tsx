"use client";

import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  Tabs,
  TextField,
} from "@heroui/react";
import {
  ChangeBar,
  Chart,
  type ChartData,
  CodeEditor,
  ConditionTile,
  DataTable,
  type DayId,
  DayPicker,
  Disclose,
  dataColumns,
  EnterpriseRequired,
  LineDiff,
  MetricPickRow,
  ModelPicker,
  OpenDashLogo,
  OpenDashMark,
  Pair,
  type PairState,
  PathLabel,
  type PickerGroup,
  type PickerValue,
  ProviderMark,
  RecordList,
  RoutineSentence,
  RunTimeline,
  SidePanel,
  StatusBadge,
  ThresholdPreview,
  TracedNumber,
  TriggerCard,
  useDataTable,
  type VerificationStatus,
} from "@opendash/ui";
import {
  Activity,
  ArrowLeftRight,
  CalendarClock,
  ChevronRight,
  DatabaseZap,
  History,
  Maximize2,
  Plus,
  RefreshCw,
  Settings,
  SquarePen,
  Target,
  Trash2,
  Undo2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ClarifyCard } from "@/components/ask/clarify-card";
import { RunStepsView } from "@/components/ask/run-steps-view";
import { ServerGlyph } from "@/components/connections/shared";
import { SourceTile } from "@/components/sources/source-tile";
import type { RunStep } from "@/lib/run-steps";

const PAIR_STATES: PairState[] = ["idle", "listening", "thinking", "working", "success", "attention", "sleeping"];
const buttonVariants = ["primary", "secondary", "tertiary", "outline", "ghost", "danger", "danger-soft"] as const;
const chipVariants = ["primary", "secondary", "soft", "tertiary"] as const;
const chipColors = ["default", "accent", "success", "warning", "danger"] as const;
const statuses: VerificationStatus[] = ["unverified", "in-progress", "verified", "stale", "failed", "error"];

const swatches = [
  ["background", "bg-background"],
  ["surface", "bg-surface"],
  ["default", "bg-default"],
  ["accent", "bg-accent"],
  ["accent-soft", "bg-accent-soft"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
  ["danger", "bg-danger"],
  ["chart-1", "bg-chart-1"],
  ["chart-2", "bg-chart-2"],
  ["chart-3", "bg-chart-3"],
  ["chart-4", "bg-chart-4"],
  ["chart-5", "bg-chart-5"],
  ["chart-6", "bg-chart-6"],
] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-small font-medium uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

interface SampleTable {
  id: string;
  table: string;
  rows: number | undefined;
  column: string;
}

const sampleTables: SampleTable[] = [
  { id: "1", table: "public.subscriptions", rows: 48_210, column: "started_at" },
  { id: "2", table: "billing.invoices", rows: 402_118, column: "issued_at" },
  { id: "3", table: "public.plans", rows: 6, column: "—" },
  { id: "4", table: "support.tickets", rows: undefined, column: "created_at" },
];
const sampleCol = dataColumns<SampleTable>();
const sampleColumns = sampleCol.columns([
  sampleCol.accessor("table", {
    header: "Table",
    meta: { rowHeader: true },
    cell: ({ getValue }) => <span className="font-mono">{getValue()}</span>,
  }),
  sampleCol.accessor("rows", {
    header: "Rows",
    sortUndefined: "last",
    meta: { align: "end" },
    cell: ({ getValue }) => <span className="tabular-nums">{getValue()?.toLocaleString("en-US") ?? "—"}</span>,
  }),
  sampleCol.accessor("column", { header: "Time column", enableSorting: false }),
]);

// Grouped by schema, the way the conversations list groups by day: a heading row per group, the grouped column removed.
const groupedColumns = sampleCol.columns([
  sampleCol.accessor((r) => r.table.split(".")[0] ?? "", { id: "schema", header: "Schema" }),
  ...sampleColumns,
]);

/** DataTable (packages/ui) in both variants, grouped, and empty; Rows and Table sort, Time column doesn't. */
function Tables() {
  const framed = useDataTable({ columns: sampleColumns, data: sampleTables, getRowId: (r) => r.id });
  const grouped = useDataTable({
    columns: groupedColumns,
    data: sampleTables,
    getRowId: (r) => r.id,
    groupedColumnMode: "remove",
    initialState: { grouping: ["schema"], expanded: true },
  });
  const plain = useDataTable({ columns: sampleColumns, data: sampleTables, getRowId: (r) => r.id });
  const empty = useDataTable({ columns: sampleColumns, data: [] as SampleTable[], getRowId: (r) => r.id });
  return (
    <div className="flex flex-col gap-4">
      <DataTable table={framed} label="Framed table" footer="4 tables" />
      <DataTable table={plain} label="Plain table" variant="plain" />
      <DataTable table={grouped} label="Grouped table" footer="4 tables in 3 schemas" />
      <DataTable
        table={empty}
        label="Empty table"
        empty={<p className="py-6 text-center text-body text-muted">Connect a source to see its tables.</p>}
      />
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Panel({ theme }: { theme: "light" | "dark" }) {
  return (
    <div
      data-theme={theme}
      className={`${theme} flex min-w-0 flex-1 flex-col gap-8 rounded-2xl border border-border bg-background p-6 text-foreground`}
    >
      <header className="flex items-baseline justify-between">
        <h1 className="text-title">{theme === "light" ? "Light" : "Dark"}</h1>
        <span className="font-mono text-small text-muted-tertiary">data-theme="{theme}"</span>
      </header>

      <Section title="Buttons">
        <Row>
          {buttonVariants.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant === "danger-soft" ? "Danger soft" : variant[0]?.toUpperCase() + variant.slice(1)}
            </Button>
          ))}
        </Row>
        <Row>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button>
            <Plus />
            New query
          </Button>
          <Button isIconOnly aria-label="Refresh" variant="secondary">
            <RefreshCw />
          </Button>
          <Button isIconOnly aria-label="Settings" variant="tertiary">
            <Settings />
          </Button>
          <Button isIconOnly aria-label="Delete" variant="danger-soft">
            <Trash2 />
          </Button>
        </Row>
      </Section>

      <Section title="Chips">
        {chipVariants.map((variant) => (
          <Row key={variant}>
            {chipColors.map((color) => (
              <Chip key={color} variant={variant} color={color}>
                {color[0]?.toUpperCase() + color.slice(1)}
              </Chip>
            ))}
          </Row>
        ))}
      </Section>

      <Section title="The logo (Pair + Outfit)">
        <Row>
          <span className="text-foreground">
            <OpenDashLogo className="h-10" />
          </span>
          <span className="text-foreground">
            <OpenDashLogo className="h-6" />
          </span>
          <OpenDashMark className="size-10 text-brand" />
          <OpenDashMark className="size-6 text-foreground" />
        </Row>
      </Section>

      <Section title="Source tiles: each database's logo on white, as the landing site shows it; a letter where there's none">
        <Row>
          {DIALECTS.map((kind) => (
            <SourceTile key={kind} kind={kind} />
          ))}
        </Row>
        <Row>
          {DIALECTS.map((kind) => (
            <SourceTile key={kind} kind={kind} size="lg" />
          ))}
        </Row>
      </Section>

      <Section title="Connected services: the logo by the server's address, a letter for one OpenDash doesn't know">
        {(["xs", "sm", "md", "lg"] as const).map((size) => (
          <Row key={size}>
            {SERVERS.map(([name, host]) => (
              <ServerGlyph key={`${name}@${host}`} name={name} host={host} size={size} />
            ))}
          </Row>
        ))}
      </Section>

      <Section title="Pair, the agent's character">
        <Row>
          {PAIR_STATES.map((state) => (
            <span key={state} className="flex w-20 flex-col items-center gap-1 text-small text-muted">
              <Pair state={state} size={36} />
              {state}
            </span>
          ))}
        </Row>
        <Row>
          <Pair size={24} />
          <Pair size={28} />
          <Pair size={36} />
          <Pair size={64} />
          <Pair size={104} interactive label="Pair, idle: hover and click it" />
        </Row>
        <Row>
          <Pair state="working" />
          <span className="text-small text-muted">moving</span>
          <Pair state="success" still />
          <span className="text-small text-muted">still: a finished run</span>
        </Row>
      </Section>

      <Section title="A section that opens smoothly: Disclose (motion)">
        <DiscloseSample />
      </Section>

      <Section title="An enterprise feature the license doesn't cover (OpenDash)">
        <EnterpriseRequired
          title="Single sign-on needs an Enterprise license"
          items={[
            "OIDC and SAML 2.0 identity providers: Okta, Entra ID, Google Workspace",
            "DNS proof of your domain, then a test sign-in before anyone depends on it",
            "Require it for everyone at your domain, with a way back in if the provider fails",
          ]}
        >
          Set OPENDASH_LICENSE_KEY in the instance's settings and restart it.
        </EnterpriseRequired>
      </Section>

      <Section title="Verification status (OpenDash)">
        <Row>
          {statuses.map((status) => (
            <StatusBadge key={status} status={status} />
          ))}
        </Row>
      </Section>

      <Section title="The analyst beside a page: side panel and change bar (OpenDash)">
        <ChangeBar
          title="The analyst changed 2 things"
          detail="v12 → v14 · shared, so people see it now"
          actions={
            <>
              <Button size="sm" variant="ghost">
                <History className="size-3.5" aria-hidden />
                History
              </Button>
              <Button size="sm" variant="outline">
                <Undo2 className="size-3.5" aria-hidden />
                Undo
              </Button>
            </>
          }
        />
        <ChangeBar title="The analyst is changing this dashboard" detail="v13 saved: a Plan filter" />
        {/* A transformed box holds the panel's phone overlay (fixed) inside it here. */}
        <div className="flex h-96 translate-x-0 gap-0 overflow-hidden rounded-sheet bg-background p-2">
          <div className="flex-1 rounded-sheet border border-border bg-surface p-4 text-body text-muted">The page</div>
          <SidePanel
            title="Ask"
            subtitle="A plan filter on Customer usage"
            onClose={() => undefined}
            actions={
              <>
                <Button isIconOnly size="sm" variant="ghost" aria-label="New conversation">
                  <SquarePen className="size-4 text-muted" aria-hidden />
                </Button>
                <Button isIconOnly size="sm" variant="ghost" aria-label="Expand">
                  <Maximize2 className="size-4 text-muted" aria-hidden />
                </Button>
              </>
            }
          >
            <p className="p-4 text-body text-muted">The conversation, then the composer.</p>
          </SidePanel>
        </div>
        <div className="flex h-72 translate-x-0 overflow-hidden rounded-sheet bg-background p-2">
          <div className="flex-1 rounded-sheet border border-border bg-surface p-4 text-body text-muted">The page</div>
          <SidePanel
            title="History"
            subtitle="Customer usage"
            back={{ crumb: "Ask", onPress: () => undefined }}
            onClose={() => undefined}
            wide
          >
            <p className="p-4 text-body text-muted">Stacked one level, 640 wide.</p>
          </SidePanel>
        </div>
      </Section>

      <Section title="A run's timeline (OpenDash)">
        <RunTimeline
          ticks={["0s", "40s", "1m 20s", "2m 00s", "2m 40s"]}
          marks={[0.325]}
          selected="d2"
          onSelect={() => undefined}
          rows={[
            {
              id: "run",
              label: "Drafting 4 tables on warehouse",
              level: 0,
              time: "2m 40s",
              segments: [{ from: 0, to: 1, kind: "span" }],
            },
            {
              id: "s1",
              label: "draft_tables × 2",
              level: 1,
              time: "6.1s",
              segments: [
                { from: 0, to: 0.04, kind: "model" },
                { from: 0.04, to: 0.97, kind: "tool" },
              ],
            },
            {
              id: "d1",
              label: "public.accounts, public.plans",
              level: 2,
              time: "1m 08s",
              segments: [
                { from: 0.04, to: 0.09, kind: "model" },
                { from: 0.09, to: 0.1, kind: "tool" },
                { from: 0.1, to: 0.17, kind: "model" },
                { from: 0.17, to: 0.21, kind: "tool" },
              ],
            },
            {
              id: "d2",
              label: "support.tickets",
              level: 2,
              time: "1m 27s",
              segments: [
                { from: 0.04, to: 0.46, kind: "wait" },
                { from: 0.46, to: 0.52, kind: "model" },
                { from: 0.52, to: 0.54, kind: "tool" },
                { from: 0.54, to: 1, kind: "running" },
              ],
            },
          ]}
        />
      </Section>

      <Section title="Traced numbers and path labels (OpenDash)">
        <Row>
          <PathLabel path="metric" />
          <PathLabel path="unmodelled" />
        </Row>
        <p className="text-lead">
          Churned MRR was <TracedNumber display="$9,800.00" /> last month, down{" "}
          <TracedNumber display="12.5%" selected /> from September; <TracedNumber display="$4,100.00" unverified /> came
          from the Pro plan.
        </p>
      </Section>

      <Section title="Charts (OpenDash)">
        <div className="grid grid-cols-2 gap-4">
          <Chart chart={SAMPLE_BARS} label="Churned MRR by plan, August and September" />
          <Chart chart={SAMPLE_LINE} label="MRR by month" />
          <Chart chart={SAMPLE_LONG_NAMES} label="Orders by process, long names" />
        </div>
      </Section>

      <Section title="Questions back (OpenDash)">
        <QuestionsSample />
      </Section>

      <Section title="Code editor (OpenDash)">
        <EditorSample />
      </Section>

      <Section title="A draft against its released version: line diff (OpenDash)">
        <LineDiff
          lines={[
            { kind: "gap", lines: 4 },
            { kind: "same", text: "measure: mrr" },
            { kind: "removed", text: "default_grain: month", mark: [15, 20] },
            { kind: "added", text: "default_grain: quarter", mark: [15, 22] },
            { kind: "same", text: "segments:" },
            { kind: "same", text: "  - test_accounts" },
            { kind: "added", text: "  - refunded_items" },
            { kind: "gap", lines: 1 },
          ]}
        />
      </Section>

      <Section title="Routines (OpenDash)">
        <RoutinesSample />
      </Section>

      <Section title="Model picker: by provider, with thinking (OpenDash)">
        <ModelPickerSample />
      </Section>

      <Section title="Fields">
        <div className="grid grid-cols-2 gap-4">
          <TextField name={`email-${theme}`} type="email">
            <Label>Email</Label>
            <Input placeholder="ops@acme.com" />
            <Description>Used for digests and alerts</Description>
          </TextField>
          <Select placeholder="Select a source">
            <Label>Source</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {["Postgres · prod", "ClickHouse · events", "Stripe"].map((source) => (
                  <ListBox.Item key={source} id={source} textValue={source}>
                    {source}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs>
          <Tabs.ListContainer>
            <Tabs.List aria-label="Settings sections">
              {["Account", "Settings", "Team"].map((tab) => (
                <Tabs.Tab key={tab} id={tab}>
                  {tab}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </Section>

      <Section title="Selection">
        <Row>
          <Checkbox defaultSelected name={`notify-${theme}`}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              Notifications
            </Checkbox.Content>
          </Checkbox>
          <Checkbox name={`remember-${theme}`}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              Remember me
            </Checkbox.Content>
          </Checkbox>
          <Switch defaultSelected>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              Weekly digest
            </Switch.Content>
          </Switch>
        </Row>
      </Section>

      <Section title="Alerts">
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Update available</Alert.Title>
            <Alert.Description>A new context release is ready. Review the changes before publishing.</Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="primary">
            Review
          </Button>
        </Alert>
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Stale dashboard</Alert.Title>
            <Alert.Description>The MRR metric changed. Two tiles need re-verification.</Alert.Description>
          </Alert.Content>
        </Alert>
      </Section>

      <Section title="A run's steps: RunStepsView, with steps that didn't work (OpenDash)">
        <RunStepsSample />
      </Section>

      <Section title="The records behind a number: RecordList (OpenDash)">
        <RecordsSample />
      </Section>
      <Section title="Tables (DataTable)">
        <Tables />
      </Section>

      <Section title="Type scale">
        <div className="flex flex-col gap-1">
          <span className="text-display">Display 28</span>
          <span className="text-title">Title 18</span>
          <span className="text-heading">Heading 14</span>
          <span className="text-body">Body 13: the answer gate recomputed every claim.</span>
          <span className="text-small font-medium">Label 12</span>
          <span className="text-small text-muted">Caption 12, secondary</span>
          <span className="font-mono text-small tabular-nums">mono 12 · 412,309.50</span>
        </div>
      </Section>

      <Section title="Colour tokens">
        <div className="grid grid-cols-7 gap-2">
          {swatches.map(([name, cls]) => (
            <div key={name} className="flex flex-col gap-1">
              <div className={`${cls} h-8 rounded-lg border border-border`} />
              <span className="font-mono text-micro text-muted">{name}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

const DIALECTS = [
  "postgres",
  "mysql",
  "clickhouse",
  "snowflake",
  "bigquery",
  "databricks",
  "redshift",
  "duckdb",
  "trino",
  "mssql",
];
/** Names and addresses as admins add them: the last two have no mark (a look-alike name on another address, an own server). */
const SERVERS: [string, string][] = [
  ["Jira", "mcp.atlassian.com"],
  ["Confluence", "mcp.atlassian.com"],
  ["GitHub", "api.githubcopilot.com"],
  ["Linear", "mcp.linear.app"],
  ["Notion", "mcp.notion.com"],
  ["HubSpot", "mcp.hubspot.com"],
  ["Stripe", "mcp.stripe.com"],
  ["Zendesk", "acme.zendesk.com"],
  ["Sentry", "mcp.sentry.dev"],
  ["Slack", "mcp.slack.com"],
  ["Google Drive", "drive.googleapis.com"],
  ["Supabase", "mcp.supabase.com"],
  ["Jira", "jira-mcp.example.com"],
  ["Incidents", "status.acme.internal"],
];

export function Gallery() {
  return (
    <div className="flex flex-col gap-6 p-6 lg:flex-row">
      <Panel theme="light" />
      <Panel theme="dark" />
    </div>
  );
}

const SAMPLE_YAML =
  "name: mrr\nlabel: Monthly recurring revenue\ndataset: mrr_snapshot\nmeasure: mrr\ndefault_grain: quarter\n";

/** Disclose: always mounted, it grows to its content's height and fades in; the chevron turns with it. */
function DiscloseSample() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group flex w-fit items-center gap-1.5 text-body text-muted hover:text-foreground"
      >
        Thought for 4s
        <ChevronRight className="size-3.5 transition-transform group-aria-expanded:rotate-90" aria-hidden />
      </button>
      <Disclose open={open} className="pt-2">
        <p className="rounded-xl bg-surface-secondary px-3 py-2 text-small text-muted">
          They want last month against the one before. MRR is verified, so the metric path, by month.
        </p>
      </Disclose>
    </div>
  );
}

/** Questions back: several at once, the picks sent as one message; and one, answered by a press. */
function QuestionsSample() {
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="grid max-w-3xl gap-4">
      <ClarifyCard outcome={SAMPLE_QUESTIONS} can onAsk={setSent} />
      {sent ? <p className="whitespace-pre-line text-small text-muted">Sent: {sent}</p> : null}
      <ClarifyCard
        outcome={{ kind: "clarify", question: "Which revenue?", options: ["MRR", "Bookings", "Recognized"] }}
        can
        onAsk={setSent}
      />
    </div>
  );
}

/** The code editor with a changed line (5) and the line a problem is on (3). */
function EditorSample() {
  const [value, setValue] = useState(SAMPLE_YAML);
  return (
    <CodeEditor
      label="Sample YAML"
      value={value}
      onValueChange={setValue}
      marks={{ 3: "error", 5: "changed" }}
      header={<span className="font-mono text-small text-muted">/sources/opendash_demo/metrics/mrr.yaml</span>}
      footer={<span className="text-danger">Line 3: there's no dataset mrr_snapshot.</span>}
    />
  );
}

const point = (value: number, display: string) => ({ value, display });
const SAMPLE_BARS: ChartData = {
  type: "bar",
  horizontal: true,
  categories: ["Starter", "Growth", "Scale"],
  series: [
    { name: "August", points: [point(5200, "$5.2k"), point(3700, "$3.7k"), point(2300, "$2.3k")] },
    { name: "September", points: [point(4100, "$4.1k"), point(3600, "$3.6k"), point(2100, "$2.1k")] },
  ],
};
/** Several questions at once, one taking more than one pick. */
const SAMPLE_QUESTIONS = {
  kind: "clarify" as const,
  questions: [
    {
      question: "Which measure matters most?",
      options: ["Orders: how often they're placed", "Customers placing them", "Products listed"],
      multiple: true,
    },
    { question: "Which time window?", options: ["The last complete year", "The last 3 months", "Month by month"] },
  ],
};

/** Names as long as real ones get: on the page they end in "…", the tooltip has the rest. */
const SAMPLE_LONG_NAMES: ChartData = {
  type: "bar",
  horizontal: true,
  categories: [
    "Gift wrapping | questions by email",
    "Guide: shop process: packing large furniture orders for the van crew",
    "SPRING_SALE_2026 + BUNDLE_OFFER_V2 (catalog LIVE) v1",
    "Gift card process",
  ],
  series: [
    {
      name: "Runs",
      points: [point(3640, "3,640"), point(1700, "1,700"), point(1520, "1,520"), point(790, "790")],
    },
  ],
};
const SAMPLE_LINE: ChartData = {
  type: "line",
  horizontal: false,
  categories: ["July 2026", "August 2026", "September 2026"],
  series: [{ name: "MRR", points: [point(381200, "$381.2k"), point(395900, "$395.9k"), point(412600, "$412.6k")] }],
};

const PICKER_LEVELS = [
  { id: "low", label: "Low", blurb: "Thinks briefly. Fastest and cheapest, for simple lookups." },
  { id: "medium", label: "Medium", blurb: "Some thought. Quick, for everyday questions." },
  { id: "high", label: "High", blurb: "Thinks it through. Claude's default, and what OpenDash is measured on." },
  { id: "xhigh", label: "Extra", blurb: "Extra high: thinks longer first. Slower, for hard questions and Apps." },
  { id: "max", label: "Max", blurb: "As long as it needs. The slowest and most expensive." },
];
const claude = (id: string, label: string, blurb: string) => ({
  id,
  label,
  blurb,
  measured: { passed: 21, total: 21 },
  levels: ["low", "medium", "high", "xhigh", "max"],
  defaultLevel: "high",
});
const PICKER_GROUPS: PickerGroup[] = [
  {
    provider: "opendash",
    label: "OpenDash",
    short: "OpenDash",
    mono: "Vi",
    note: "Calls on OpenDash",
    models: [
      claude("claude-sonnet-5-5", "Claude Sonnet 5.5", "Balanced: strong and quick"),
      claude("claude-haiku-5-5", "Claude Haiku 5.5", "The fastest and cheapest"),
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        blurb: "OpenAI's flagship",
        measured: null,
        levels: ["low", "medium", "high", "xhigh", "max"],
        defaultLevel: "high",
      },
    ],
  },
  {
    provider: "bedrock",
    label: "Amazon Bedrock",
    short: "Bedrock",
    mono: "Br",
    note: "Your AWS account · eu-central-1",
    models: [claude("claude-sonnet-5-5", "Claude Sonnet 5.5", "Balanced: strong and quick")],
  },
];

/** The picker: models under each provider, a search, thinking below; a provider's mark beside it. */
function ModelPickerSample() {
  const [value, setValue] = useState<PickerValue>({
    model: "claude-sonnet-5-5",
    provider: "opendash",
    reasoning: "high",
  });
  return (
    <div className="flex flex-col gap-3">
      <Row>
        <ModelPicker
          groups={PICKER_GROUPS}
          levels={PICKER_LEVELS}
          value={value}
          onChange={setValue}
          name="Model for this question"
          variant="ghost"
          placement="top start"
          team={{ model: "claude-sonnet-5-5", provider: "opendash", reasoning: "high" }}
          footer="Your admins choose what's offered."
        />
        <ModelPicker
          groups={PICKER_GROUPS}
          levels={PICKER_LEVELS}
          value={value}
          onChange={setValue}
          name="Default model"
          full
          footer="Picked from the models your providers offer."
        />
      </Row>
      <Row>
        <ProviderMark provider="opendash" mono="Vi" />
        <ProviderMark provider="gateway" mono="GW" />
        <ProviderMark provider="bedrock" mono="Br" />
        <ProviderMark provider="vertex" mono="Vx" size="sm" />
      </Row>
    </div>
  );
}

/** A routine's pieces: its sentence, what starts it, what counts, its metrics, its days, its line. */
function RoutinesSample() {
  const [trigger, setTrigger] = useState<"schedule" | "found">("schedule");
  const [condition, setCondition] = useState("crosses");
  const [days, setDays] = useState<DayId[]>(["mon"]);
  const [picked, setPicked] = useState(["mrr"]);
  const [part, setPart] = useState<string | null>(null);
  const weeks = [
    "Jul 20",
    "Jul 27",
    "Aug 3",
    "Aug 10",
    "Aug 17",
    "Aug 24",
    "Aug 31",
    "Sep 7",
    "Sep 14",
    "Sep 21",
    "Sep 28",
    "Oct 5",
  ];
  const mrr = [381, 384, 386, 389, 391, 394, 396, 401, 404, 407, 409, 412.6];
  return (
    <div className="grid max-w-3xl gap-5">
      <div className="flex flex-col gap-2 rounded-xl bg-surface-secondary p-4">
        <span className="text-small font-medium uppercase tracking-wide text-muted">This routine</span>
        <RoutineSentence
          size="lg"
          onPart={(_, p) => setPart(p.text)}
          parts={[
            { text: "Every Monday at 07:00", role: "when" },
            { text: ", " },
            { text: "send Business review with a written summary", role: "what" },
            { text: " to " },
            { text: "me and Ines", role: "where" },
            { text: "." },
          ]}
        />
        {part ? <span className="text-small text-muted">Opens its part: {part}</span> : null}
      </div>
      <RoutineSentence
        parts={[
          { text: "When " },
          { text: "MRR drops a lot", role: "when", open: true },
          { text: ", " },
          { text: "tell", role: "what" },
          { text: " " },
          { text: "the team", role: "where", open: true },
          { text: " at once", role: "what" },
          { text: "." },
        ]}
      />
      <div role="radiogroup" aria-label="What starts it" className="grid gap-3 @lg:grid-cols-2">
        <TriggerCard
          icon={CalendarClock}
          title="On a schedule"
          description="Every day, week or month, at a time you pick."
          selected={trigger === "schedule"}
          onSelect={() => setTrigger("schedule")}
        />
        <TriggerCard
          icon={Activity}
          title="When something is found"
          description="Checked as each week's data lands: unusual, crosses a line, a goal at risk, or data missing."
          selected={trigger === "found"}
          onSelect={() => setTrigger("found")}
        />
      </div>
      <div role="radiogroup" aria-label="What counts" className="grid gap-2 @lg:grid-cols-4">
        {[
          {
            id: "unusual",
            icon: Activity,
            title: "It's unusual",
            description: "Outside its range from the 12 weeks before.",
          },
          {
            id: "crosses",
            icon: ArrowLeftRight,
            title: "It crosses a line",
            description: "Below or above a value you set.",
          },
          { id: "goal", icon: Target, title: "A goal is at risk", description: "Its forecast misses the target." },
          {
            id: "missing",
            icon: DatabaseZap,
            title: "Its data is missing",
            description: "Not in when it's checked.",
            disabled: true,
          },
        ].map((c) => (
          <ConditionTile
            key={c.id}
            icon={c.icon}
            title={c.title}
            description={c.description}
            selected={condition === c.id}
            disabled={c.disabled}
            onSelect={() => setCondition(c.id)}
          />
        ))}
      </div>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
        {[
          { id: "mrr", title: "MRR", detail: "Weekly · $412.6k last week", by: 2, values: mrr },
          {
            id: "churn",
            title: "Churned MRR",
            detail: "Weekly · $9.8k last week",
            by: 1,
            values: [12, 9, 11, 10, 8, 9.8],
          },
          { id: "paying", title: "Paying customers", detail: "Monthly, before its first check", by: 0 },
        ].map((m) => (
          <MetricPickRow
            key={m.id}
            title={m.title}
            detail={m.detail}
            watchedBy={m.by}
            {...(m.values ? { values: m.values } : {})}
            selected={picked.includes(m.id)}
            onChange={(on) => setPicked(on ? [...picked, m.id] : picked.filter((x) => x !== m.id))}
          />
        ))}
      </div>
      <DayPicker value={days} onChange={setDays} />
      <ThresholdPreview
        label="MRR by week"
        periods={weeks}
        values={mrr.map((v) => ({ value: v * 1000, display: `$${v}k` }))}
        line={{ value: 400_000, display: "$400k" }}
        axis={{ currency: "USD", compact: true }}
        note="Over the last 12 weeks this would have stayed quiet: MRR rose above $400k on Sep 7."
      />
    </div>
  );
}

const TICKET_COLUMNS = [
  { name: "id", label: "ID", type: "number" as const },
  { name: "created_at", label: "Created at", type: "time" as const },
  { name: "accounts__name", label: "Account", type: "string" as const },
  { name: "subject", label: "Subject", type: "string" as const },
  { name: "priority", label: "Priority", type: "string" as const },
  { name: "status", label: "Status", type: "string" as const },
  { name: "csat", label: "CSAT", type: "number" as const },
  { name: "mrr_usd", label: "MRR", type: "number" as const, format: "usd" as const },
];
const TICKET_ROWS: unknown[][] = [
  [4112, "2026-09-28T14:03:11Z", "Lumen Works", "Charged twice this month", "urgent", "open", null, 1240],
  [4097, "2026-09-27T09:41:00Z", "Cedar Systems", "Can't log in after password reset", "high", "pending", null, 412.5],
  [
    4090,
    "2026-09-26T00:00:00Z",
    "Atlas Analytics",
    "Export to CSV is slow, and times out for any range over a quarter",
    "urgent",
    "solved",
    4,
    18_250.4,
  ],
  [4071, "2026-09-24T17:22:48Z", "Harbor Labs", "Invoice shows the wrong VAT number", "high", "failed", 2, 0],
  [4066, "2026-09-24T08:05:30Z", "Nova Retail", "How do I add seats?", "low", "solved", 5, 96],
];

const RETRIED_STEPS: RunStep[] = [
  { key: "a", status: "ok", label: "Read context", detail: "Catalog of acme_production" },
  {
    key: "b",
    status: "fail",
    label: "Entity operations",
    detail: "system.columns isn't a table in this source's catalog.",
  },
  { key: "c", status: "ok", label: "q2 · Tenants by type", detail: "71 ms · 4 rows" },
  { key: "d", status: "ok", label: "q3 · Task execution types", detail: "2.3 s · 5 rows" },
  {
    key: "e",
    status: "fail",
    label: "Tickets, latest version",
    detail: "support.tickets is a ReplacingMergeTree: a row can have older versions that a plain count includes",
  },
  {
    key: "f",
    status: "ok",
    label: "Thinking",
    detail: "Thought for 7s",
    notes: "Count the latest version of each ticket.",
  },
  { key: "g", status: "ok", label: "q4 · Open tickets", detail: "124 ms · 1 row" },
  { key: "h", status: "fail", label: "Orders by region", detail: "Code: 999. Something nobody planned for happened" },
];

/** A run's steps: the quiet retried rows while it goes on and when it's done, and red only for a run that failed. */
function RunStepsSample() {
  return (
    <div className="flex max-w-md flex-col gap-6">
      <RunStepsView summary="Worked for 24s" steps={RETRIED_STEPS} status="done" />
      <RunStepsView summary="Working…" steps={RETRIED_STEPS.slice(0, 5)} status="active" />
      <RunStepsView summary="Couldn't answer" steps={RETRIED_STEPS} status="failed" />
    </div>
  );
}

function RecordsSample() {
  const [page, setPage] = useState(0);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="text-small text-muted">
          Ready: money, dates, status tones, a long text cut short, empty cells
        </span>
        <RecordList
          columns={TICKET_COLUMNS}
          rows={TICKET_ROWS}
          page={page}
          pageSize={5}
          total={1402}
          cap={1000}
          noun="tickets"
          label="Sample tickets"
          onPage={setPage}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-small text-muted">Another page on its way: the rows stay, dimmed</span>
        <RecordList
          columns={TICKET_COLUMNS}
          rows={TICKET_ROWS}
          page={1}
          pageSize={5}
          total={12}
          cap={1000}
          noun="tickets"
          label="Busy"
          busy
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-small text-muted">Trimmed: the page came back shorter than it should</span>
        <RecordList
          columns={TICKET_COLUMNS}
          rows={TICKET_ROWS.slice(0, 2)}
          page={0}
          pageSize={5}
          total={5}
          cap={1000}
          noun="tickets"
          label="Trimmed"
          trimmed
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-small text-muted">Empty</span>
        <RecordList
          columns={TICKET_COLUMNS}
          rows={[]}
          page={0}
          pageSize={25}
          total={0}
          cap={1000}
          noun="tickets"
          label="Empty"
        />
      </div>
    </div>
  );
}
