"use client";

import {
  Button,
  Checkbox,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Switch,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
} from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { CredentialField, PickableModel, ProviderView } from "@opendash/core";
import { ProviderMark } from "@opendash/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CircleAlert, CircleCheck, KeyRound, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { apiQueries } from "@/lib/api";
import { shortDate } from "@/lib/format";

type Levels = { id: string; label: string; blurb: string }[];

/** A refusal's own words, or the fallback. */
export const aiMessage = (e: unknown, fallback: string) =>
  isDefinedError(e) ? (e as { message: string }).message : fallback;

/** Where a provider's models come from, in the dialog's words. */
function sourceOf(p: ProviderView, values: Record<string, string>): string {
  const where = values.region || values.location || p.shown.region || p.shown.location || "";
  switch (p.kind) {
    case "opendash":
      return p.via === "gateway" ? "Vercel AI Gateway's model list" : "the models this server has keys for";
    case "gateway":
      return "Vercel AI Gateway's model list";
    case "openrouter":
      return "OpenRouter's model list";
    case "bedrock":
      return `the models AWS offers in ${where || "the region"}`;
    case "vertex":
      return `the models Google offers in ${where || "the location"}`;
    default:
      return "the models this key can use";
  }
}

const shownLine = (p: ProviderView) => {
  const parts = [
    p.shown.key ? `Key ending ${p.shown.key.replace(/^…/, "")}` : null,
    p.shown.region,
    p.shown.project,
    p.shown.location,
  ];
  const worked = p.listedAt ? `last worked ${shortDate(p.listedAt)}` : null;
  return [...parts, worked].filter(Boolean).join(" · ");
};

function Step({ n, done, title }: { n: number; done: boolean; title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-micro font-medium tracking-wide text-muted-tertiary uppercase">
      <span
        aria-hidden
        className={`flex size-4.5 items-center justify-center rounded-full ${done ? "bg-success-soft text-success" : "bg-surface-secondary text-muted"}`}
      >
        {done ? <Check className="size-3" /> : n}
      </span>
      {title}
    </h3>
  );
}

/** One field of a kind's credentials, as its registry entry says. */
function Field({
  field,
  value,
  onChange,
}: {
  field: CredentialField;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = (
    <Label>
      {field.label}
      {field.optional ? <span className="font-normal text-muted-tertiary"> optional</span> : null}
    </Label>
  );
  if (field.input === "select") {
    return (
      <Select
        className={field.half ? "min-w-0 flex-1" : "w-full"}
        value={value || null}
        placeholder="Choose one"
        onChange={(key) => onChange(String(key ?? ""))}
      >
        {label}
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {(field.options ?? []).map((o) => (
              <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
                {o.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
        {field.hint ? <Description>{field.hint}</Description> : null}
      </Select>
    );
  }
  return (
    <TextField className={field.half ? "min-w-0 flex-1" : "w-full"} value={value} onChange={onChange}>
      {label}
      {field.input === "textarea" ? (
        <TextArea
          rows={4}
          spellCheck={false}
          className="font-mono text-small"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const file = e.dataTransfer.files[0];
            if (!file) return;
            e.preventDefault();
            void file.text().then(onChange);
          }}
        />
      ) : (
        <Input
          type={field.input === "password" ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          {...(field.placeholder ? { placeholder: field.placeholder } : {})}
        />
      )}
      {field.hint ? <Description>{field.hint}</Description> : null}
    </TextField>
  );
}

/**
 * The models people can pick from it: its own list met with the allowlist, the measured ones ticked to begin with.
 * One OpenDash hasn't measured with the analyst is shown but can't be ticked until it is.
 */
function ModelList({
  models,
  levels,
  ticked,
  onTick,
  source,
  missing,
  label,
  deployment = false,
}: {
  models: PickableModel[];
  levels: Levels;
  ticked: Set<string>;
  onTick: (next: Set<string>) => void;
  source: string;
  missing: string[];
  label: string;
  /** OpenDash's own: a model missing is one this server has no key for. */
  deployment?: boolean;
}) {
  const levelLine = (m: PickableModel) =>
    m.levels.map((id) => levels.find((l) => l.id === id)?.label ?? id).join(" · ");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-small text-muted">From {source}, limited to the models OpenDash allows.</p>
        <button
          type="button"
          className="shrink-0 text-small text-link hover:underline"
          onClick={() => onTick(new Set(models.filter((m) => m.measured).map((m) => m.id)))}
        >
          Select all
        </button>
      </div>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        {models.map((m) => (
          <li key={m.id} className="px-2.5 py-2">
            <Checkbox
              isSelected={ticked.has(m.id) && Boolean(m.measured)}
              isDisabled={!m.measured}
              onChange={(on) => {
                const next = new Set(ticked);
                if (on) next.add(m.id);
                else next.delete(m.id);
                onTick(next);
              }}
              className="w-full"
            >
              <Checkbox.Content className="w-full items-start">
                <Checkbox.Control className="mt-0.5">
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">
                    {m.label}
                    {m.measured ? null : (
                      <Chip size="sm" variant="soft">
                        Not measured yet
                      </Chip>
                    )}
                  </span>
                  <span className="text-small text-muted-tertiary">
                    {m.measured ? m.blurb : `${m.blurb}. Offered once OpenDash has measured it.`}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  {m.measured ? (
                    <Chip size="sm" variant="soft" color="success">
                      {m.measured.passed}/{m.measured.total}
                    </Chip>
                  ) : null}
                  <span className="text-small text-muted-tertiary">{levelLine(m)}</span>
                </span>
              </Checkbox.Content>
            </Checkbox>
          </li>
        ))}
      </ul>
      {missing.length ? (
        <p className="text-small text-muted-tertiary">
          {missing.join(", ")} {missing.length === 1 ? "isn't" : "aren't"}{" "}
          {deployment ? "here: this server has no key for its maker." : `on ${label} yet.`}
        </p>
      ) : null}
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-border px-3 py-4 text-center text-small text-muted-tertiary">{children}</p>
  );
}

/**
 * A provider's dialog: connect (its own form, then a test with one small call; nothing is
 * saved until Set up), then the models people can pick from what its own list offers; then Set up, Save, or Remove.
 * A provider already set up shows its credentials' ending, with Replace (tested before it takes over) and, when it
 * isn't working, Test again. OpenDash has nothing to set up: it can be turned off, and its models ticked.
 */
export function ProviderDialog({
  provider,
  levels,
  onClose,
  onChanged,
}: {
  provider: ProviderView | null;
  levels: Levels;
  onClose: () => void;
  onChanged: () => void;
}) {
  // A dialog of its own for each provider, so each opening starts from what's saved.
  return provider ? (
    <DialogBody key={provider.kind} p={provider} levels={levels} onClose={onClose} onChanged={onChanged} />
  ) : null;
}

function DialogBody({
  p,
  levels,
  onClose,
  onChanged,
}: {
  p: ProviderView;
  levels: Levels;
  onClose: () => void;
  onChanged: () => void;
}) {
  const opendash = p.kind === "opendash";
  const isNew = p.state === "not_set_up";
  const [replacing, setReplacing] = useState(false);
  const [mode, setMode] = useState(p.modes[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [testId, setTestId] = useState<string | null>(null);
  // What someone ticked; until then, what's saved or what the test's list starts with.
  const [touched, setTouched] = useState<Set<string> | null>(null);
  const [enabled, setEnabled] = useState(p.state !== "off");

  const test = useQuery({
    ...apiQueries.ai.providerTest.queryOptions({ input: { testId: testId ?? "" } }),
    enabled: testId !== null,
    refetchInterval: (q) => (q.state.data?.state === "testing" || !q.state.data ? 1000 : false),
  });
  const result = testId ? (test.data ?? null) : null;

  const start = useMutation(apiQueries.ai.testProvider.mutationOptions());
  const save = useMutation(apiQueries.ai.saveProvider.mutationOptions());
  const setModels = useMutation(apiQueries.ai.setProviderModels.mutationOptions());
  const remove = useMutation(apiQueries.ai.removeProvider.mutationOptions());
  const retest = useMutation(apiQueries.ai.retestProvider.mutationOptions());

  const fields = useMemo(() => p.fields.filter((f) => !f.mode || f.mode === mode), [p, mode]);

  const connecting = isNew || replacing;
  const credentials = Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? ""]));
  const filled = fields.every((f) => f.optional || (values[f.name] ?? "").trim() !== "");
  const testing = start.isPending || result?.state === "testing" || (testId !== null && !result);
  const passed = result?.state === "ok";
  const models = connecting ? (passed ? result.models : []) : p.models;
  const ticked = touched ?? new Set(models.filter((m) => m.picked).map((m) => m.id));
  const missing = connecting ? (passed ? result.missing : []) : p.missing;
  const editable = opendash || (connecting ? passed : p.state === "working" || p.state === "off");
  const done = () => {
    onChanged();
    onClose();
  };
  const fail = (fallback: string) => (e: unknown) => toast.danger(aiMessage(e, fallback));

  const runTest = () =>
    start.mutate(
      { kind: p.kind, credentials },
      {
        onSuccess: (r) => {
          setTouched(null);
          setTestId(r.testId);
        },
        onError: fail("Couldn't start the test."),
      },
    );
  const submit = () => {
    const picked = [...ticked];
    if (connecting) {
      if (!testId) return;
      save.mutate(
        { kind: p.kind, testId, picked },
        {
          onSuccess: () => {
            toast.success(isNew ? `${p.label} is set up.` : `${p.label} saved.`);
            done();
          },
          onError: fail("Couldn't save it."),
        },
      );
      return;
    }
    setModels.mutate(
      { kind: p.kind, picked, ...(opendash ? { enabled } : {}) },
      { onSuccess: done, onError: fail("Couldn't save it.") },
    );
  };

  const status = (() => {
    if (testing) {
      return (
        <span className="flex items-center gap-1.5 text-small text-muted">
          <Spinner size="sm" />
          Testing… OpenDash reads its models and asks one small question.
        </span>
      );
    }
    if (result?.state === "ok") {
      return (
        <span className="flex items-center gap-1.5 text-small text-success">
          <CircleCheck className="size-3.5 shrink-0" aria-hidden />
          Connected. It can run {result.models.length} of the models OpenDash allows.
        </span>
      );
    }
    if (result?.state === "failed") {
      return (
        <span className="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 wrap-anywhere">{result.message ?? "The test failed."}</span>
        </span>
      );
    }
    return (
      <span className="text-small text-muted-tertiary">
        OpenDash makes one small call to check it. Nothing is saved until you set it up.
      </span>
    );
  })();

  const pending = save.isPending || setModels.isPending;
  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog aria-label={p.label}>
            <Modal.CloseTrigger />
            <Modal.Header className="flex flex-row items-center gap-3 border-b border-border pb-3">
              <ProviderMark provider={p.kind} mono={p.mono} />
              <Modal.Heading>{isNew ? `Set up ${p.label}` : p.label}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4 pt-3">
              <p className="text-body text-muted">
                {p.blurb} {p.kind === "opendash" ? "Calls are on OpenDash." : `${p.billing}.`}
              </p>
              {opendash ? (
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-secondary px-3 py-2">
                  <CircleCheck className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 text-small text-muted">
                    Nothing to set up.{" "}
                    {p.via === "gateway"
                      ? "Its calls run through Vercel AI Gateway."
                      : "Its calls run on each maker's own key."}
                  </span>
                  <Switch size="sm" isSelected={enabled} onChange={setEnabled}>
                    <Switch.Content>
                      <Label className="text-small">Offer its models</Label>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </div>
              ) : (
                <section className="flex flex-col gap-3">
                  <Step n={1} done={passed || (!connecting && p.state === "working")} title="Connect" />
                  {connecting ? (
                    <>
                      {p.modes.length ? (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-small font-medium">Sign in with</span>
                          <ToggleButtonGroup
                            aria-label="Sign in with"
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={new Set([mode])}
                            onSelectionChange={(keys) => {
                              const next = [...keys][0];
                              if (next) setMode(String(next));
                            }}
                            size="sm"
                            className="w-fit"
                          >
                            {p.modes.map((m, i) => (
                              <ToggleButton key={m.id} id={m.id}>
                                {i ? <ToggleButtonGroup.Separator /> : null}
                                {m.label}
                              </ToggleButton>
                            ))}
                          </ToggleButtonGroup>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-3">
                        {fields.map((f) => (
                          <Field
                            key={f.name}
                            field={f}
                            value={values[f.name] ?? ""}
                            onChange={(v) => {
                              setValues((old) => ({ ...old, [f.name]: v }));
                              // New credentials need a new test.
                              setTestId(null);
                            }}
                          />
                        ))}
                      </div>
                      {p.hint ? <p className="text-small text-muted-tertiary">{p.hint}</p> : null}
                      <div className="flex flex-wrap items-center gap-3">
                        <Button
                          size="sm"
                          variant="outline"
                          isDisabled={!filled || testing}
                          isPending={start.isPending}
                          onPress={runTest}
                        >
                          {result?.state === "failed" ? "Test again" : "Test connection"}
                        </Button>
                        <span className="min-w-0 flex-1">{status}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-secondary px-3 py-2">
                        <KeyRound className="size-3.5 shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-small text-muted">{shownLine(p)}</span>
                        <Button size="sm" variant="outline" onPress={() => setReplacing(true)}>
                          Replace
                        </Button>
                      </div>
                      {p.state === "not_working" || p.state === "testing" ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            size="sm"
                            variant="outline"
                            isPending={retest.isPending || p.state === "testing"}
                            onPress={() =>
                              retest.mutate(
                                { kind: p.kind },
                                { onSuccess: onChanged, onError: fail("Couldn't test it.") },
                              )
                            }
                          >
                            <RefreshCw className="size-3.5" aria-hidden />
                            Test again
                          </Button>
                          {p.message ? (
                            <span className="flex min-w-0 flex-1 items-start gap-1.5 text-small text-danger">
                              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              <span className="min-w-0 wrap-anywhere">{p.message}</span>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </section>
              )}
              <section className="flex flex-col gap-2">
                {opendash ? (
                  <h3 className="text-micro font-medium tracking-wide text-muted-tertiary uppercase">
                    Models people can pick
                  </h3>
                ) : (
                  <Step n={2} done={false} title="Models people can pick" />
                )}
                {editable && models.length ? (
                  <ModelList
                    models={models}
                    levels={levels}
                    ticked={ticked}
                    onTick={setTouched}
                    source={sourceOf(p, values)}
                    missing={missing}
                    label={p.label}
                    deployment={opendash && p.via === "direct"}
                  />
                ) : connecting ? (
                  <Placeholder>Test the connection to see which models it can run.</Placeholder>
                ) : (
                  <Placeholder>
                    Fix the connection to change its models.
                    {p.models.some((m) => m.picked)
                      ? ` Until then, ${p.models
                          .filter((m) => m.picked)
                          .map((m) => m.label)
                          .join(
                            ", ",
                          )} ${p.models.filter((m) => m.picked).length === 1 ? "isn't" : "aren't"} offered through ${p.label}.`
                      : ""}
                  </Placeholder>
                )}
              </section>
            </Modal.Body>
            <Modal.Footer className="flex items-center gap-2 border-t border-border pt-3">
              {!isNew && !opendash ? (
                <Button
                  size="sm"
                  variant="danger-soft"
                  isPending={remove.isPending}
                  onPress={() =>
                    remove.mutate(
                      { kind: p.kind },
                      {
                        onSuccess: () => {
                          toast.success(`${p.label} removed.`);
                          done();
                        },
                        onError: fail("Couldn't remove it."),
                      },
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
              <span className="flex-1" />
              <Button size="sm" variant="ghost" slot="close">
                Cancel
              </Button>
              <Button size="sm" isPending={pending} isDisabled={connecting ? !passed : !editable} onPress={submit}>
                <Check className="size-3.5" aria-hidden />
                {isNew ? "Set up" : "Save"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
