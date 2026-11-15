"use client";

import {
  Button,
  Dropdown,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  Tag,
  TagGroup,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import type { ComposerChoices, MetricChoice } from "@opendash/core";
import { displayMetric, type Sensitivity, type Weekday } from "@opendash/core/routines";
import { ConditionTile, DayPicker, MetricPickRow, ThresholdPreview } from "@opendash/ui";
import { Activity, ArrowLeftRight, Clock, DatabaseZap, Hash, Mail, Plus, Search, Target } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { type ComposerSlack, crossings, type Draft, parseLine, type Repeats } from "@/lib/routine-draft";
import { whenLine } from "@/lib/routine-words";

type Patch = (patch: Partial<Draft>) => void;

const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
);
const WEEK = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** A section's heading, with what it's for beside it. */
export function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="shrink-0 text-heading font-medium">{title}</span>
      <span className="text-small text-muted">{hint}</span>
    </h2>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      isDisabled={disabled}
      selectedKeys={new Set([value])}
      onSelectionChange={(keys) => {
        const next = [...keys][0] as T | undefined;
        if (next && next !== value) onChange(next);
      }}
      size="sm"
      className="w-fit"
    >
      {options.map((o, i) => (
        <ToggleButton key={o.id} id={o.id}>
          {i ? <ToggleButtonGroup.Separator /> : null}
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 @2xl/page:flex-row @2xl/page:items-center @2xl/page:gap-4">
      <span className="w-20 shrink-0 text-small text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Picker({
  label,
  value,
  items,
  placeholder,
  onChange,
  className,
}: {
  label: string;
  value: string | null;
  items: { id: string; label: string }[];
  placeholder: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(key) => key && onChange(String(key))}
      className={className ?? "w-64"}
    >
      <Label className="sr-only">{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((i) => (
            <ListBox.Item key={i.id} id={i.id} textValue={i.label}>
              {i.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/** On a schedule: how often, which days, at what time, and its next three times. */
export function ScheduleWhen({ draft, set, tz, next }: { draft: Draft; set: Patch; tz: string; next: string[] }) {
  const times = TIMES.includes(draft.at) ? TIMES : [...TIMES, draft.at].sort();
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface-secondary p-4">
      <Row label="Repeats">
        <Segmented<Repeats>
          label="Repeats"
          value={draft.repeats}
          onChange={(repeats) => set({ repeats })}
          options={[
            { id: "day", label: "Every day" },
            { id: "weekday", label: "Every weekday" },
            { id: "week", label: "Every week" },
            { id: "month", label: "Every month" },
          ]}
        />
      </Row>
      {draft.repeats === "week" ? (
        <Row label="On">
          <DayPicker value={draft.days} onChange={(days) => set({ days: days as Weekday[] })} />
        </Row>
      ) : null}
      {draft.repeats === "month" ? (
        <Row label="On">
          <Segmented
            label="Which day of the month"
            value={draft.on}
            onChange={(on) => set({ on })}
            options={[
              { id: "first", label: "The first day" },
              { id: "last", label: "The last day" },
            ]}
          />
        </Row>
      ) : null}
      <Row label="At">
        <Picker
          label="At"
          value={draft.at}
          placeholder="07:00"
          items={times.map((t) => ({ id: t, label: t }))}
          onChange={(at) => set({ at })}
          className="w-28"
        />
        <span className="flex items-center gap-1.5 text-small text-muted">
          <Clock className="size-3.5" aria-hidden />
          {tz}, the workspace's time zone
        </span>
      </Row>
      {next.length ? (
        <Row label="Next">
          {next.map((n) => (
            <span key={n} className="rounded-md border border-border bg-surface px-2 py-0.5 text-small tabular-nums">
              {whenLine(n, tz)}
            </span>
          ))}
        </Row>
      ) : null}
    </div>
  );
}

const periodLabel = (period: string, grain: MetricChoice["grain"]) => {
  const d = new Date(`${period}T00:00:00Z`);
  return grain === "week" ? WEEK.format(d) : MONTH.format(d);
};

/** When something is found: which metrics, what counts, and a line's preview over its recent periods. */
export function FoundWhen({
  draft,
  set,
  choices,
  watching,
  savedIds,
}: {
  draft: Draft;
  set: Patch;
  choices: ComposerChoices;
  watching: boolean;
  /** The metrics this routine watched when it was opened (they count it among their watchers). */
  savedIds: string[];
}) {
  const [query, setQuery] = useState("");
  const one = draft.condition === "crosses";
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return choices.metrics.filter((m) => !q || m.title.toLowerCase().includes(q));
  }, [choices.metrics, query]);
  const picked = choices.metrics.filter((m) => draft.metricIds.includes(m.id));
  const lineMetric = one ? picked[0] : undefined;
  const lineValue = lineMetric ? parseLine(draft.line, lineMetric.format) : null;
  const grains = new Set(picked.map((m) => m.grain));
  const monthlyOnly = picked.length > 0 && grains.size === 1 && grains.has("month");
  const toggle = (id: string, on: boolean) =>
    set({
      metricIds: one ? (on ? [id] : []) : on ? [...draft.metricIds, id] : draft.metricIds.filter((m) => m !== id),
    });

  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-surface-secondary p-4">
      <div className="flex flex-col gap-2">
        <SectionHead
          title={one ? "Which metric" : "Which metrics"}
          hint="Verified metrics only. Each is checked once a period, however many routines watch it."
        />
        {choices.metrics.length ? (
          <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-3.5 shrink-0 text-muted" aria-hidden />
              <input
                aria-label="Search metrics"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search metrics"
                className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-tertiary"
              />
              <span className="shrink-0 text-small text-muted">{draft.metricIds.length} picked</span>
            </div>
            <div className="flex max-h-80 flex-col overflow-y-auto">
              {shown.map((m) => (
                <MetricPickRow
                  key={m.id}
                  title={m.title}
                  detail={`${m.grain === "week" ? "Weekly" : "Monthly"}${
                    m.latest ? ` · ${m.latest.display} ${m.grain === "week" ? "last week" : "last month"}` : ""
                  } · ${m.connectionName}`}
                  watchedBy={Math.max(0, m.watchedBy - (savedIds.includes(m.id) ? 1 : 0))}
                  values={m.points.map((p) => p.value)}
                  selected={draft.metricIds.includes(m.id)}
                  onChange={(on) => toggle(m.id, on)}
                />
              ))}
              {shown.length ? null : <p className="px-3 py-4 text-body text-muted">No metric matches “{query}”.</p>}
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-body text-muted">
            No verified metric with weeks or months yet. Verify one in Knowledge, then watch it here.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionHead title="What counts" hint="Pick one" />
        <div
          role="radiogroup"
          aria-label="What counts"
          className="grid gap-2 @xl/page:grid-cols-2 @5xl/page:grid-cols-4"
        >
          <ConditionTile
            icon={Activity}
            title="It's unusual"
            description="Outside its usual range, or its trend shifts."
            selected={draft.condition === "unusual"}
            onSelect={() => set({ condition: "unusual" })}
          />
          <ConditionTile
            icon={ArrowLeftRight}
            title="It crosses a line"
            description="Below or above a value you set."
            selected={draft.condition === "crosses"}
            disabled={watching}
            onSelect={() => set({ condition: "crosses", metricIds: draft.metricIds.slice(0, 1) })}
          />
          <ConditionTile
            icon={Target}
            title="A goal is at risk"
            description="Its forecast misses the target."
            selected={draft.condition === "goal_risk"}
            disabled={watching}
            onSelect={() => set({ condition: "goal_risk" })}
          />
          <ConditionTile
            icon={DatabaseZap}
            title="Its data is missing"
            description="Not in when it's checked."
            selected={draft.condition === "missing"}
            disabled={watching}
            onSelect={() => set({ condition: "missing" })}
          />
        </div>
      </div>

      {draft.condition === "unusual" ? (
        <Row label="Sensitivity">
          <Segmented<Sensitivity>
            label="How unusual counts"
            value={draft.sensitivity}
            onChange={(sensitivity) => set({ sensitivity })}
            options={[
              { id: "lower", label: "Lower" },
              { id: "medium", label: "Medium" },
              { id: "higher", label: "Higher" },
            ]}
          />
          <span className="text-small text-muted">Higher finds more.</span>
        </Row>
      ) : null}

      {one ? (
        <div className="flex flex-col gap-2">
          <SectionHead
            title="The line"
            hint={lineMetric ? `${lineMetric.title}, by ${lineMetric.grain}` : "Pick the metric first"}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Which way"
              value={draft.direction}
              onChange={(direction) => set({ direction })}
              options={[
                { id: "below", label: "Falls below" },
                { id: "above", label: "Rises above" },
              ]}
            />
            <TextField
              aria-label="The line's value"
              value={draft.line}
              onChange={(line) => set({ line })}
              isInvalid={draft.line.trim() !== "" && lineValue === null}
              className="w-36"
            >
              <Input
                placeholder={
                  lineMetric?.format === "percent" ? "38%" : lineMetric?.format === "usd" ? "$400k" : "1,200"
                }
              />
            </TextField>
            {lineMetric && lineValue !== null ? (
              <span className="text-small text-muted">
                It tells once when {lineMetric.title} crosses {displayMetric(lineMetric.format, lineValue)}, and again
                only after it's back {draft.direction === "below" ? "above" : "below"}.
              </span>
            ) : draft.line.trim() && lineValue === null ? (
              <span className="text-small text-danger">Write a number, like 400k or 38%.</span>
            ) : null}
          </div>
          {lineMetric && lineMetric.points.length > 1 ? (
            <LinePreview metric={lineMetric} line={lineValue} direction={draft.direction} />
          ) : lineMetric ? (
            <p className="text-small text-muted">Its preview shows once it has been checked a few times.</p>
          ) : null}
        </div>
      ) : null}

      <p className="flex items-center gap-1.5 text-small text-muted">
        <Clock className="size-3.5 shrink-0" aria-hidden />
        {monthlyOnly
          ? "Checked at 06:00 the morning after each month closes, once its data is in. There's no time to pick: it runs when the data does."
          : "Checked at 06:00 once each week's data is in (monthly metrics after each month closes). There's no time to pick: it runs when the data does."}
      </p>
    </div>
  );
}

function LinePreview({
  metric,
  line,
  direction,
}: {
  metric: MetricChoice;
  line: number | null;
  direction: "below" | "above";
}) {
  const values = metric.points.map((p) => p.value);
  const n = metric.points.length;
  const span = `${n} ${metric.grain === "week" ? "weeks" : "months"}`;
  let note: string | undefined;
  if (line !== null) {
    const c = crossings(values, direction, line);
    const at = c.last !== null ? metric.points[c.last] : undefined;
    const when = at ? `${metric.grain === "week" ? "the week of " : ""}${periodLabel(at.period, metric.grain)}` : "";
    note =
      c.times === 0
        ? `Over the last ${span} this would have stayed quiet.`
        : `Over the last ${span} this would have told you ${c.times === 1 ? "once" : `${c.times} times`}, last in ${when}.`;
  }
  return (
    <ThresholdPreview
      label={`${metric.title} by ${metric.grain}`}
      periods={metric.points.map((p) => periodLabel(p.period, metric.grain))}
      values={metric.points.map((p) => ({ value: p.value, display: p.display }))}
      line={line !== null ? { value: line, display: displayMetric(metric.format, line) } : null}
      axis={
        metric.format === "usd"
          ? { currency: "USD", compact: true }
          : metric.format === "percent"
            ? { percent: true }
            : { compact: true }
      }
      note={note}
    />
  );
}

/** What a scheduled routine does each time. */
export function ScheduledWhat({
  draft,
  set,
  choices,
  canAsk,
}: {
  draft: Draft;
  set: Patch;
  choices: ComposerChoices;
  /** Not a viewer: a question is theirs. */
  canAsk: boolean;
}) {
  const option = (
    id: Draft["action"],
    title: string,
    description: string,
    extra: ReactNode,
    last = false,
    disabled = false,
  ) => (
    <div className={`flex flex-col gap-3 px-4 py-3 ${last ? "" : "border-b border-border"}`}>
      <label className={`flex items-start gap-3 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
        <input
          type="radio"
          name="routine-what"
          checked={draft.action === id}
          disabled={disabled}
          onChange={() => set({ action: id })}
          className="mt-1 accent-accent"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body font-medium">{title}</span>
          <span className="text-small text-muted">{description}</span>
        </span>
      </label>
      {draft.action === id ? extra : null}
    </div>
  );
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
      {option(
        "ask",
        "Ask a question",
        canAsk
          ? "Asked fresh each time. The answer is checked like any other and kept in its conversation in Ask."
          : "Asking is for members: a viewer's routine sends what's there.",
        <div className="flex flex-col gap-3 ps-7">
          <TextField value={draft.question} onChange={(question) => set({ question })} aria-label="The question">
            <TextArea rows={2} maxLength={500} placeholder="Which plans grew this week, and why?" />
          </TextField>
          {choices.sources.length > 1 ? (
            <Picker
              label="Source"
              value={draft.connectionId}
              placeholder="Pick a source"
              items={choices.sources.map((s) => ({ id: s.id, label: s.name }))}
              onChange={(connectionId) => set({ connectionId })}
            />
          ) : null}
        </div>,
        false,
        !canAsk,
      )}
      {option(
        "digest",
        "Send what OpenDash found",
        "What's open in Insights and each person's open tasks, each with why. Nothing found, nothing sent.",
        null,
        true,
      )}
    </div>
  );
}

/** How the news goes out, for a routine that watches. */
export function FoundTell({
  draft,
  set,
  canAsk,
}: {
  draft: Draft;
  set: Patch;
  /** Not a viewer: working out why is theirs. */
  canAsk: boolean;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body font-medium">When it goes out</span>
          <span className="text-small text-muted">
            At once suits a line or a goal. A daily roundup at 07:00 suits many metrics, and skips quiet days.
          </span>
        </span>
        <Segmented
          label="When it goes out"
          value={draft.tell}
          onChange={(tell) => set({ tell })}
          options={[
            { id: "at_once", label: "At once" },
            { id: "roundup", label: "Daily roundup" },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body font-medium">Investigate first</span>
          <span className="text-small text-muted">
            {canAsk
              ? "OpenDash works out why before it tells anyone, from the background budget. It waits at most 30 minutes."
              : "Working out why is for members: a viewer's routine tells what it found."}
          </span>
        </span>
        <Switch
          size="sm"
          aria-label="Investigate first"
          isDisabled={!canAsk}
          isSelected={draft.investigate}
          onChange={(investigate) => set({ investigate })}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>
    </div>
  );
}

/** The Slack channels it posts to (owners and admins), from the connected workspace's. */
function SlackRow({
  draft,
  set,
  slack,
  canManage,
}: {
  draft: Draft;
  set: Patch;
  slack: ComposerSlack;
  canManage: boolean;
}) {
  const picked = draft.slack;
  const open = slack.kind === "ready" ? slack.channels.filter((c) => !picked.some((p) => p.channelId === c.id)) : [];
  const note = !canManage
    ? "Owners and admins post routines to channels."
    : slack.kind === "off"
      ? null
      : slack.kind === "problem"
        ? slack.message
        : picked.length
          ? null
          : slack.channels.some((c) => c.member)
            ? "No channel. Add one to post there too."
            : "OpenDash isn't in a channel yet: /invite @opendash in one, then reload.";
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2.5 ${canManage ? "" : "opacity-70"}`}
    >
      <Hash className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="w-14 shrink-0 text-body">Slack</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {picked.length ? (
          <TagGroup
            aria-label="Channels it posts to"
            size="sm"
            onRemove={(keys) => set({ slack: picked.filter((c) => !keys.has(c.channelId)) })}
          >
            <TagGroup.List className="flex flex-wrap gap-1.5">
              {picked.map((c) => (
                <Tag key={c.channelId} id={c.channelId} textValue={`#${c.name}`}>
                  #{c.name}
                </Tag>
              ))}
            </TagGroup.List>
          </TagGroup>
        ) : null}
        {note ? <span className="text-small text-muted">{note}</span> : null}
        {canManage && slack.kind === "off" ? (
          <span className="text-small text-muted">
            Connect Slack to post in its channels:{" "}
            <Link href="/settings/slack" className="text-link hover:underline">
              Settings → Slack
            </Link>
            .
          </span>
        ) : null}
      </div>
      {canManage && slack.kind === "ready" && open.some((c) => c.member) ? (
        <Dropdown>
          <Button size="sm" variant="ghost">
            <Plus className="size-3.5" aria-hidden />
            Channel
          </Button>
          <Dropdown.Popover placement="bottom end" className="max-h-80 min-w-60">
            <Dropdown.Menu
              aria-label={`Channels in ${slack.teamName}`}
              disabledKeys={open.filter((c) => !c.member).map((c) => c.id)}
              onAction={(key) => {
                const c = open.find((x) => x.id === String(key));
                if (c?.member) set({ slack: [...picked, { teamId: slack.teamId, channelId: c.id, name: c.name }] });
              }}
            >
              {open.map((c) => (
                <Dropdown.Item key={c.id} id={c.id} textValue={c.name}>
                  <Label>
                    #{c.name}
                    {c.member ? "" : " · invite @opendash first"}
                  </Label>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
    </div>
  );
}

/** Who hears about it: people by email, and Slack channels. */
export function Where({
  draft,
  set,
  members,
  me,
  canManage,
  workspace,
  slack,
}: {
  draft: Draft;
  set: Patch;
  members: { userId: string; name: string }[];
  me: string;
  canManage: boolean;
  workspace: string;
  slack: ComposerSlack;
}) {
  const nameOf = (id: string) =>
    id === me ? "You" : (members.find((m) => m.userId === id)?.name ?? "Someone who left");
  const picked = [...draft.userIds].sort((a, b) => Number(b === me) - Number(a === me));
  const rest = members.filter((m) => !draft.userIds.includes(m.userId));
  return (
    <div className="flex flex-col gap-2">
      <SlackRow draft={draft} set={set} slack={slack} canManage={canManage} />
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2.5">
        <Mail className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="w-14 shrink-0 text-body">Email</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {picked.length ? (
            <TagGroup
              aria-label="People it emails"
              size="sm"
              onRemove={(keys) => set({ userIds: draft.userIds.filter((u) => !keys.has(u)) })}
            >
              <TagGroup.List className="flex flex-wrap gap-1.5">
                {picked.map((u) => (
                  <Tag key={u} id={u} textValue={nameOf(u)}>
                    {nameOf(u)}
                  </Tag>
                ))}
              </TagGroup.List>
            </TagGroup>
          ) : (
            <span className="text-small text-muted">Nobody yet.</span>
          )}
        </div>
        {canManage ? (
          rest.length ? (
            <Dropdown>
              <Button size="sm" variant="ghost">
                <Plus className="size-3.5" aria-hidden />
                People
              </Button>
              <Dropdown.Popover placement="bottom end" className="max-h-80 min-w-56">
                <Dropdown.Menu onAction={(key) => set({ userIds: [...draft.userIds, String(key)] })}>
                  {rest.map((m) => (
                    <Dropdown.Item key={m.userId} id={m.userId} textValue={m.name}>
                      <Label>{m.userId === me ? "You" : m.name}</Label>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          ) : null
        ) : !draft.userIds.includes(me) ? (
          <Button size="sm" variant="ghost" onPress={() => set({ userIds: [...draft.userIds, me] })}>
            <Plus className="size-3.5" aria-hidden />
            You
          </Button>
        ) : null}
      </div>
      <p className="text-small text-muted-tertiary">
        {canManage
          ? `Members of ${workspace} only, and each email has a one-click unsubscribe. A channel sees only what everyone in the workspace can open.`
          : "Yours alone: owners and admins send routines to others."}
      </p>
    </div>
  );
}
