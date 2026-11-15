"use client";

import { Button, Chip } from "@heroui/react";
import type { CommonValuesAnswer } from "@opendash/core";
import { List } from "lucide-react";
import { useState } from "react";
import { termCommonValues } from "@/app/(app)/knowledge/glossary/[id]/values-action";

const POLL_MS = 1_000;
const WAIT_MS = 30_000;

const ago = (iso: string) => {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
};

/**
 * A term's column values aren't kept in OpenDash. "Show common values" reads them from the source
 * (a worker does, so the page asks again until they're in), then shows them as chips, the term's own values in the
 * accent.
 */
export function CommonValues({
  termId,
  column,
  source,
  mapped,
}: {
  termId: string;
  column: string;
  /** The source's name, as the line says where they're read from. */
  source: string;
  /** The values the term maps to. */
  mapped: string[];
}) {
  const [state, setState] = useState<CommonValuesAnswer | "idle" | "reading">("idle");
  const show = async () => {
    setState("reading");
    const started = Date.now();
    for (;;) {
      const answer: CommonValuesAnswer = await termCommonValues(termId).catch(() => ({
        status: "failed" as const,
        message: "Couldn't read them.",
      }));
      if (answer.status !== "queued") return setState(answer);
      if (Date.now() - started > WAIT_MS) {
        return setState({ status: "failed", message: "It's taking longer than usual. Try again." });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  if (typeof state === "object" && state.status === "succeeded") {
    const chosen = new Set(mapped);
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-small text-muted-tertiary">
          {column} · most common values · read from {source} {ago(state.ranAt)} · not kept
        </p>
        {state.values.length ? (
          <div className="flex flex-wrap gap-1.5">
            {state.values.map((v) => (
              <Chip
                key={v.value}
                size="sm"
                variant="soft"
                {...(chosen.has(v.value) ? { color: "accent" as const } : {})}
              >
                <span className="font-mono">{v.value}</span>
                <span className="text-muted-tertiary tabular-nums">· {v.rows.toLocaleString("en-US")}</span>
              </Chip>
            ))}
            {state.more ? <span className="self-center text-small text-muted-tertiary">and more</span> : null}
          </div>
        ) : (
          <p className="text-small text-muted">It has no values yet.</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-small text-muted-tertiary">
        {column} · its values aren't kept in OpenDash; they're read from {source} when you ask
      </p>
      <Button size="sm" variant="outline" isPending={state === "reading"} onPress={() => void show()}>
        <List className="size-3.5" aria-hidden />
        {typeof state === "object" && state.status === "failed" ? "Try again" : "Show common values"}
      </Button>
      {typeof state === "object" && state.status === "failed" ? (
        <p className="text-small text-danger">{state.message}</p>
      ) : null}
    </div>
  );
}
