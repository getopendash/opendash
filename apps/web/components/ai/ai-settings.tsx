"use client";

import { Button, Skeleton, Spinner, toast } from "@heroui/react";
import type { ModelChoice, ProviderKind, ProviderView } from "@opendash/core";
import { DataTable, dataColumns, ModelPicker, ProviderMark, useDataTable } from "@opendash/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { pickerGroups } from "@/components/ask/model-picker";
import { apiQueries } from "@/lib/api";
import { shortDateTime } from "@/lib/format";
import { aiMessage, ProviderDialog } from "./provider-dialog";

const GROUPS: Record<ProviderView["group"], string> = {
  opendash: "",
  gateways: "Gateways",
  makers: "Model makers",
  clouds: "Your own cloud",
};

/** What a provider's row says under its name: how it runs, which credentials, or what it is. */
export function providerLine(p: ProviderView): string {
  if (p.kind === "opendash") {
    if (p.state === "not_working") return "This server has no AI keys of its own.";
    if (p.state === "off") return "Turned off: its models aren't offered.";
    return p.via === "gateway" ? "Through Vercel AI Gateway" : "Through each maker's own key";
  }
  if (p.state === "not_set_up") return p.blurb;
  const key = p.shown.key ? `Key ending ${p.shown.key.replace(/^…/, "")}` : null;
  const where = [p.shown.project, p.shown.region ?? p.shown.location].filter(Boolean).join(" · ");
  const parts = p.kind === "bedrock" ? [p.shown.region, p.shown.key] : p.kind === "vertex" ? [where] : [key];
  const checked = p.state === "working" && p.testedAt ? `checked ${shortDateTime(p.testedAt)}` : null;
  return [...parts, checked].filter(Boolean).join(" · ");
}

const short = (label: string) => label.replace(/^Claude /, "");

/** The models people can pick from a provider, by short name: "Sonnet 5.5, Opus 5.5, Haiku 5.5 +2". */
function pickedLine(p: ProviderView): string {
  const picked = p.state === "working" || p.state === "not_working" ? p.models.filter((m) => m.picked) : [];
  if (!picked.length) return "–";
  const names = picked.map((m) => short(m.label));
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}

type Row = ProviderView & { open: (kind: ProviderKind) => void };

function Status({ p }: { p: ProviderView }) {
  if (p.state === "testing") {
    return (
      <span className="flex items-center gap-1.5 text-muted">
        <Spinner size="sm" />
        Testing…
      </span>
    );
  }
  if (p.state === "working" || p.state === "not_working") {
    const ok = p.state === "working";
    return (
      <span className={`flex items-center gap-1.5 ${ok ? "text-foreground" : "text-danger"}`}>
        <span aria-hidden className={`size-1.5 rounded-full ${ok ? "bg-success" : "bg-danger"}`} />
        {ok ? "Working" : p.kind === "opendash" ? "Not available" : "Not working"}
      </span>
    );
  }
  return <span className="text-muted-tertiary">{p.state === "off" ? "Off" : "Not set up"}</span>;
}

const col = dataColumns<Row>();
const columns = col.columns([
  col.accessor((p) => GROUPS[p.group], { id: "group", header: "Group" }),
  col.accessor("label", {
    header: "Provider",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ row: { original: p } }) => (
      <span className="flex items-center gap-3">
        <ProviderMark provider={p.kind} mono={p.mono} />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{p.label}</span>
          <span className="text-small text-muted-tertiary">{providerLine(p)}</span>
          {p.message && p.kind !== "opendash" ? (
            <span className="text-small text-danger wrap-anywhere">{p.message}</span>
          ) : null}
        </span>
      </span>
    ),
  }),
  col.accessor("state", {
    header: "Status",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: p } }) => <Status p={p} />,
  }),
  col.accessor((p) => pickedLine(p), {
    id: "models",
    header: "Models people can pick",
    meta: { className: "hidden min-w-44 @3xl/page:table-cell" },
    cell: ({ getValue }) => <span className="text-muted">{getValue()}</span>,
  }),
  col.accessor("billedTo", {
    header: "Billed to",
    meta: { className: "hidden whitespace-nowrap @5xl/page:table-cell" },
    cell: ({ getValue }) => <span className="text-muted">{getValue()}</span>,
  }),
  col.display({
    id: "action",
    header: () => <span className="sr-only">Set up or edit</span>,
    meta: { align: "end", className: "whitespace-nowrap" },
    cell: ({ row: { original: p } }) =>
      p.kind === "opendash" && p.state === "not_working" ? null : p.state === "not_set_up" ? (
        <Button size="sm" variant="outline" onPress={() => p.open(p.kind)} aria-label={`Set up ${p.label}`}>
          <Plus className="size-3.5" aria-hidden />
          Set up
        </Button>
      ) : (
        <Button size="sm" variant="outline" onPress={() => p.open(p.kind)} aria-label={`Edit ${p.label}`}>
          Edit
        </Button>
      ),
  }),
]);

/**
 * Settings → AI: every kind of provider in one table, each set up or edited in its own
 * dialog, and the default, chosen with the same picker as a question's model. Owners and admins.
 */
export function AiSettings() {
  const queryClient = useQueryClient();
  const view = useQuery({
    ...apiQueries.ai.settings.queryOptions(),
    // A provider being tested again settles in a few seconds.
    refetchInterval: (q) => (q.state.data?.providers.some((p) => p.state === "testing") ? 2000 : false),
  });
  const refresh = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: apiQueries.ai.settings.queryKey() }),
        queryClient.invalidateQueries({ queryKey: apiQueries.ai.models.queryKey() }),
      ]),
    [queryClient],
  );
  const setDefault = useMutation(apiQueries.ai.setDefault.mutationOptions());
  const [open, setOpen] = useState<ProviderKind | null>(null);
  const data = view.data;
  const rows = useMemo<Row[]>(() => (data?.providers ?? []).map((p) => ({ ...p, open: setOpen })), [data]);
  const table = useDataTable({
    columns,
    data: rows,
    getRowId: (p) => p.kind,
    groupedColumnMode: "remove",
    initialState: { grouping: ["group"], expanded: true },
  });

  if (!data) return <Skeleton className="h-96 rounded-2xl" />;
  const distinct = new Set(data.offered.flatMap((g) => g.models.map((m) => m.id))).size;
  const providers = data.offered.length;
  // What new questions start with while the saved default is held: the model as the composer shows it.
  const startGroup = data.default && data.offered.find((g) => g.provider === data.default?.provider);
  const startModel = startGroup?.models.find((m) => m.id === data.default?.model);
  const startsWith = startGroup && startModel ? `${startModel.label} through ${startGroup.label}` : null;
  const editing = data.providers.find((p) => p.kind === open) ?? null;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-display">AI</h1>
        <p className="max-w-reading text-body text-muted">
          The providers your team asks through, the models each one offers, and what a question uses when nobody picks.
        </p>
      </div>
      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-body font-semibold">Providers</h2>
          <p className="text-small text-muted">
            Set one up to offer its models. Each is tested with one small call first. Its models come from its own list,
            limited to the ones OpenDash allows.
          </p>
        </div>
        <DataTable table={table} label="Providers" />
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-body font-semibold">Default model</h2>
          <p className="text-small text-muted">
            {data.default
              ? `People can pick from ${distinct} ${distinct === 1 ? "model" : "models"} across ${providers} ${providers === 1 ? "provider" : "providers"}; this one is where they start.`
              : "Nobody can ask until a provider is set up and working."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border px-4 py-3">
          {data.held || data.default ? (
            <>
              <ModelPicker
                name="Default model"
                full
                groups={pickerGroups(data.held ? [...data.offered, data.held.group] : data.offered)}
                levels={data.levels}
                value={data.held?.choice ?? data.default}
                isDisabled={setDefault.isPending}
                footer="Picked from the models your providers offer."
                onChange={(next) =>
                  setDefault.mutate(next as ModelChoice, {
                    onSuccess: () => void refresh(),
                    onError: (e) => toast.danger(aiMessage(e, "Couldn't change the default.")),
                  })
                }
              />
              {data.held ? (
                <p className="flex min-w-0 flex-1 gap-1.5 text-small text-warning">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    {data.held.group.label} isn't working, so routines, Slack and investigations wait for it: they're
                    never moved to another provider.{" "}
                    {startsWith ? `New questions start with ${startsWith} meanwhile. ` : ""}Test it again, or pick
                    another model.
                  </span>
                </p>
              ) : (
                <p className="min-w-0 flex-1 text-small text-muted">
                  New questions start with it until someone picks. Routines, Slack and investigations always use it.
                </p>
              )}
            </>
          ) : (
            <p className="w-full py-2 text-center text-small text-muted-tertiary">
              Set up a provider first. One of its models then becomes the default.
            </p>
          )}
        </div>
      </section>
      <p className="max-w-reading text-small text-muted-tertiary">
        Prices are each provider's list prices, kept with each model on the allowlist. A call through your own provider
        is billed to you by that provider; Usage shows those apart. Credentials are opened only by the worker; Settings
        shows only a key's ending, a region or a project.
      </p>
      <ProviderDialog
        provider={editing}
        levels={data.levels}
        onClose={() => setOpen(null)}
        onChanged={() => void refresh()}
      />
    </>
  );
}
