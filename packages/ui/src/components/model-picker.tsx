"use client";

import {
  Button,
  Chip,
  Description,
  Header,
  Label,
  ListBox,
  Popover,
  SearchField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { Brain, Check, ChevronDown, Sparkles } from "lucide-react";
import { type ReactNode, useDeferredValue, useState } from "react";
import { OpenDashMark } from "../icons/opendash-logo";

/** A model a person can pick, under the provider it runs on. */
export interface PickerModel {
  id: string;
  label: string;
  blurb: string;
  /** Its golden-set score, or null: "Not measured yet". */
  measured: { passed: number; total: number } | null;
  /** The thinking levels it takes, in order, and where it starts (its maker's default). */
  levels: string[];
  defaultLevel: string;
}

/** A provider's models, under its name and who's billed. */
export interface PickerGroup {
  provider: string;
  label: string;
  /** Its name where room is short, on the button: "Bedrock". */
  short: string;
  /** Two letters for its mark; OpenDash has its own. */
  mono: string;
  /** Who's billed, and where it runs: "Calls on OpenDash", "Your AWS account · eu-central-1". */
  note: string;
  models: PickerModel[];
}

export interface PickerLevel {
  id: string;
  label: string;
  blurb: string;
}

export interface PickerValue {
  model: string;
  provider: string;
  reasoning: string;
}

/** A provider's mark: OpenDash's own, else two letters on a tile. */
export function ProviderMark({ provider, mono, size = "md" }: { provider: string; mono: string; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-5 rounded-md text-micro" : "size-8 rounded-lg text-small";
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center border border-border bg-surface-secondary font-semibold text-foreground ${box}`}
    >
      {provider === "opendash" ? (
        <OpenDashMark className={size === "sm" ? "size-3.5 text-brand" : "size-5 text-brand"} />
      ) : (
        mono
      )}
    </span>
  );
}

const keyOf = (provider: string, model: string) => `${provider}:${model}`;

/** Past this many models the list gets a search. */
const SEARCH_FROM = 7;

/**
 * The model, its provider and how long it thinks: the offered models under each provider (the same
 * model can show under two, which bill differently), a search once there are many, and the levels the chosen model
 * takes below, each saying what it means. With one provider it drops the headings; with one model and nothing to
 * choose about its thinking it's a label. Choosing a model keeps the level when the model takes it, else the model's default. The
 * same picker sets Settings' default and a question's model. In the composer the button keeps the model's name whole
 * and names the provider only where its container (the composer) has room; the list and the button's label always do.
 */
export function ModelPicker({
  groups,
  levels,
  value,
  onChange,
  name = "Model",
  full = false,
  team = null,
  variant = "outline",
  placement = "bottom start",
  footer,
  isDisabled,
}: {
  groups: PickerGroup[];
  levels: PickerLevel[];
  value: PickerValue | null;
  onChange: (next: PickerValue) => void;
  /** What it chooses, for its label ("Default model", "Model for this question"). */
  name?: string;
  /** The trigger names the provider and level always (Settings), not only when they matter. */
  full?: boolean;
  /** The team's default, marked in the list (the composer's picker). */
  team?: PickerValue | null;
  /** Ghost in the composer's toolbar, outline on a settings page. */
  variant?: "outline" | "ghost";
  /** Up from a composer at the bottom of the page. */
  placement?: "bottom start" | "top start";
  /** Under the list; given `close`, a link in it can close the picker as it goes. */
  footer?: ReactNode | ((close: () => void) => ReactNode);
  isDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim().toLowerCase());
  const group = groups.find((g) => g.provider === value?.provider);
  const model = group?.models.find((m) => m.id === value?.model);
  const level = levels.find((l) => l.id === value?.reasoning) ?? levels[0];
  const twice = groups.filter((g) => g.models.some((m) => m.id === value?.model)).length > 1;
  const many = groups.length > 1;
  const shown = groups
    .map((g) => ({
      ...g,
      models: g.models.filter(
        (m) => !query || m.label.toLowerCase().includes(query) || g.label.toLowerCase().includes(query),
      ),
    }))
    .filter((g) => g.models.length);
  const choose = (key: string) => {
    const [provider, id] = key.split(/:(.*)/s) as [string, string];
    const m = groups.find((g) => g.provider === provider)?.models.find((x) => x.id === id);
    if (!m) return;
    const reasoning = value && m.levels.includes(value.reasoning) ? value.reasoning : m.defaultLevel;
    onChange({ model: m.id, provider, reasoning });
  };
  if (!model || !group || !level) return null;
  const takes = levels.filter((l) => model.levels.includes(l.id));
  const total = groups.reduce((n, g) => n + g.models.length, 0);
  if (total === 1 && takes.length < 2) {
    return (
      <span className="flex items-center gap-1 text-small text-muted" title={`${model.label} through ${group.label}`}>
        <Sparkles className="size-3" aria-hidden />
        {full ? model.label : model.label.replace(/^Claude /, "")}
      </span>
    );
  }
  const close = () => {
    setOpen(false);
    setQ("");
  };
  const below = typeof footer === "function" ? footer(close) : footer;
  return (
    <Popover
      isOpen={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <Button
        size="sm"
        variant={variant}
        isDisabled={isDisabled}
        className={variant === "ghost" ? "gap-1 text-muted" : "min-w-0"}
        aria-label={`${name}: ${model.label} through ${group.label}, thinking ${level.label}`}
      >
        <Sparkles className={variant === "ghost" ? "size-3 shrink-0" : "size-3.5 shrink-0 text-muted"} aria-hidden />
        <span className={variant === "ghost" ? "" : "max-w-72 truncate font-medium"}>
          {full ? model.label : model.label.replace(/^Claude /, "")}
        </span>
        {full ? <span className="shrink-0 text-muted">· {group.label}</span> : null}
        {!full && twice ? <span className="hidden text-muted @md:inline">· {group.short}</span> : null}
        {/* The level on the button only when it isn't the model's own default (or in full). */}
        {full || level.id !== model.defaultLevel ? <span className="shrink-0 text-accent">· {level.label}</span> : null}
        <ChevronDown className="size-3 shrink-0 text-muted" aria-hidden />
      </Button>
      <Popover.Content placement={placement} className="w-form max-w-full">
        <Popover.Dialog aria-label={name} className="flex flex-col p-0">
          {total >= SEARCH_FROM ? (
            <div className="p-1.5">
              <SearchField aria-label="Search models" value={q} onChange={setQ} autoFocus fullWidth>
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder="Search models" />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>
            </div>
          ) : null}
          {shown.length ? (
            <ListBox
              aria-label="Models"
              autoFocus={total < SEARCH_FROM ? "first" : undefined}
              className={`max-h-80 overflow-y-auto px-1.5 pb-1.5 ${total < SEARCH_FROM ? "pt-1.5" : ""}`}
              onAction={(key) => choose(String(key))}
            >
              {shown.map((g) => (
                <ListBox.Section key={g.provider}>
                  {many ? (
                    <Header className="flex items-center gap-2 px-2 pt-2 pb-1">
                      <ProviderMark provider={g.provider} mono={g.mono} size="sm" />
                      <span className="text-small font-medium text-muted">{g.label}</span>
                      <span className="ms-auto truncate text-small text-muted-tertiary">{g.note}</span>
                    </Header>
                  ) : null}
                  {g.models.map((m) => {
                    const on = m.id === model.id && g.provider === group.provider;
                    const isTeams = team?.model === m.id && team.provider === g.provider;
                    return (
                      <ListBox.Item
                        key={keyOf(g.provider, m.id)}
                        id={keyOf(g.provider, m.id)}
                        textValue={`${m.label} ${g.label}`}
                        className={on ? "bg-accent-soft" : ""}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <Label className="flex items-center gap-1.5 truncate">
                            {m.label}
                            {m.measured ? null : (
                              <Chip size="sm" variant="soft">
                                Not measured yet
                              </Chip>
                            )}
                          </Label>
                          <Description className="text-small text-muted-tertiary">
                            {isTeams ? `${m.blurb} · your team's default` : m.blurb}
                          </Description>
                        </span>
                        {m.measured ? (
                          <Chip size="sm" variant="soft" color="success">
                            {m.measured.passed}/{m.measured.total}
                          </Chip>
                        ) : null}
                        <Check className={`size-3.5 shrink-0 ${on ? "text-accent" : "invisible"}`} aria-hidden />
                      </ListBox.Item>
                    );
                  })}
                </ListBox.Section>
              ))}
            </ListBox>
          ) : (
            <p className="px-3 py-3 text-small text-muted-tertiary">No model called "{q.trim()}".</p>
          )}
          <div className="flex flex-col gap-1.5 border-t border-border p-2.5">
            <span className="flex items-center gap-1.5 text-micro font-medium tracking-wide text-muted-tertiary uppercase">
              <Brain className="size-3.5" aria-hidden />
              Thinking
            </span>
            {takes.length > 1 ? (
              <ToggleButtonGroup
                aria-label="Thinking"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([level.id])}
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (next && next !== level.id) onChange({ ...(value as PickerValue), reasoning: String(next) });
                }}
                size="sm"
                fullWidth
              >
                {takes.map((l, i) => (
                  <ToggleButton key={l.id} id={l.id}>
                    {i ? <ToggleButtonGroup.Separator /> : null}
                    {l.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            ) : null}
            <p className="text-small text-muted">{level.blurb}</p>
          </div>
          {below ? (
            <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-small text-muted-tertiary">
              {below}
            </div>
          ) : null}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
