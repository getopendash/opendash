"use client";

import { buttonVariants, Skeleton } from "@heroui/react";
import type { ProviderKind } from "@opendash/core";
import { Pair, ProviderMark } from "@opendash/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ProviderDialog } from "@/components/ai/provider-dialog";
import { apiQueries } from "@/lib/api";
import { StepSheet } from "./onboarding-shell";

/** The providers offered here, most common first: one key each. The clouds (Bedrock, Vertex) are in Settings → AI. */
const OFFERED: ProviderKind[] = ["anthropic", "openai", "google", "gateway", "openrouter"];

/**
 * The Model step: what answers the questions. Where a model already runs (the deployment's own keys, or a provider
 * the workspace set up) there's nothing to do and it says so; otherwise a provider is set up with the same dialog as
 * Settings → AI: its key, one small test call, and the models to offer.
 */
export function ModelStep({
  canSetUp,
  ready,
}: {
  canSetUp: boolean;
  ready: { label: string | null; through: string | null } | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<ProviderKind | null>(null);
  const view = useQuery({
    ...apiQueries.ai.settings.queryOptions(),
    enabled: canSetUp,
    // A provider being tested settles in a few seconds.
    refetchInterval: (q) => (q.state.data?.providers.some((p) => p.state === "testing") ? 2000 : false),
  });
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: apiQueries.ai.settings.queryKey() }),
      queryClient.invalidateQueries({ queryKey: apiQueries.ai.models.queryKey() }),
    ]);
    // The bar's ticks and the next step are read on the server.
    router.refresh();
  }, [queryClient, router]);

  const data = view.data;
  // What the server found, until the browser's own read arrives (and for someone who can't set providers up).
  const group = data?.default ? data.offered.find((g) => g.provider === data.default?.provider) : null;
  const model = group?.models.find((m) => m.id === data?.default?.model);
  const working = data ? (data.default && group ? { label: model?.label ?? null, through: group.label } : null) : ready;
  const next = (
    <Link href="/get-started/ask" className={`${buttonVariants()} gap-1.5`}>
      Continue
      <ArrowRight className="size-4" aria-hidden />
    </Link>
  );
  const back = (
    <Link href="/get-started/data" className={buttonVariants({ variant: "ghost" })}>
      Back
    </Link>
  );

  if (working) {
    const own = group?.provider === "opendash" || (!data && ready !== null);
    return (
      <StepSheet
        pair={<Pair size={64} state="success" />}
        title="A model is ready"
        lead="Nothing to set up here. The model reads your question, your definitions and the query results it asks for; the numbers in an answer always come from the queries."
        footer={
          <>
            {back}
            <span className="flex-1" />
            {next}
          </>
        }
      >
        <div className="flex items-center gap-3 rounded-2xl bg-success-soft px-4 py-3">
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
          <p className="flex min-w-0 flex-col text-body text-success-soft-foreground">
            <span className="font-medium">
              {working.label ?? "A model"}
              {working.through ? ` through ${working.through}` : ""}
            </span>
            <span className="text-small">
              {own
                ? "Included with this OpenDash. You can add your own provider any time in Settings → AI."
                : "Change it, or add more providers, any time in Settings → AI."}
            </span>
          </p>
        </div>
      </StepSheet>
    );
  }

  const providers = OFFERED.flatMap((kind) => data?.providers.find((p) => p.kind === kind) ?? []);
  const editing = data?.providers.find((p) => p.kind === open) ?? null;
  return (
    <StepSheet
      pair={<Pair size={64} state="listening" />}
      title="Bring a model"
      lead="OpenDash asks through a provider of your choice, on your own key. Pick one: it's tested with one small call before it's saved."
      footer={
        <>
          {back}
          <span className="flex-1" />
          <Link href="/get-started/ask" className={buttonVariants({ variant: "ghost" })}>
            Skip for now
          </Link>
        </>
      }
    >
      {!canSetUp ? (
        <p className="rounded-2xl bg-surface-secondary px-4 py-3 text-body text-muted">
          An owner or admin of this workspace sets up its model provider. Until then, questions can't be answered.
        </p>
      ) : !data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {providers.map((p) => (
              <li key={p.kind}>
                <button
                  type="button"
                  onClick={() => setOpen(p.kind)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-border px-3.5 py-3 text-start hover:bg-surface-secondary"
                >
                  <ProviderMark provider={p.kind} mono={p.mono} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body font-medium">{p.label}</span>
                    <span className={`text-small ${p.state === "not_working" ? "text-danger" : "text-muted"}`}>
                      {p.state === "not_working" ? (p.message ?? "Its key didn't work. Try another.") : p.blurb}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-small font-medium text-link">
                    <KeyRound className="size-3.5" aria-hidden />
                    {p.state === "not_set_up" ? "Add key" : "Edit"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-small text-muted">
            Keys are stored encrypted and never shown again. Amazon Bedrock or Google Vertex AI?{" "}
            <Link href="/settings/ai" className="text-link hover:underline">
              Settings → AI
            </Link>
          </p>
          <ProviderDialog
            provider={editing}
            levels={data.levels}
            onClose={() => setOpen(null)}
            onChanged={() => void refresh()}
          />
        </>
      )}
    </StepSheet>
  );
}
