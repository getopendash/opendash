"use client";

import type { AskableSource } from "@opendash/api/client";
import { ArrowUp, AtSign, Database } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AskComposer } from "@/components/ask/ask-composer";
import { useStartThread } from "@/components/ask/use-start-thread";
import { startingSource } from "@/lib/starting-source";
import { useSetWriting } from "./writing";

/**
 * The Home ask box. With a learned source it asks (and opens the conversation); until then there's nothing
 * to ask, so it says how to start instead of accepting a question it can't answer.
 */
export function Composer({ org, hasData, sources }: { org: string; hasData: boolean; sources: AskableSource[] }) {
  const sourceId = startingSource(sources);
  const { start, pending, error } = useStartThread();
  const setWriting = useSetWriting();
  if (sources.length) {
    return (
      <AskComposer
        sources={sources}
        sourceId={sourceId}
        placeholder={`Ask anything about ${org}'s data…`}
        running={false}
        pending={pending}
        error={error}
        onSubmit={(text, choice, attachments) => sourceId && start(sourceId, text, choice, attachments)}
        onWriting={setWriting}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-3xl border border-border-secondary bg-surface pt-3 pr-3 pb-2.5 pl-3.5">
      <textarea
        disabled
        rows={1}
        aria-label={`Ask about ${org}`}
        placeholder={
          hasData
            ? "OpenDash is still learning your data. You can ask once it's done…"
            : "Connect a data source to start asking…"
        }
        className="resize-none bg-transparent text-lead text-foreground outline-none placeholder:text-muted-tertiary disabled:cursor-not-allowed"
      />
      <div className="flex items-center justify-between gap-3">
        {hasData ? (
          <Link
            href="/data/sources"
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-small text-muted"
          >
            <Database className="size-3" aria-hidden />
            Sources
            <AtSign className="size-3" aria-hidden />
          </Link>
        ) : (
          <Link href="/data/sources/new" className="text-small text-link hover:underline">
            Connect a data source
          </Link>
        )}
        <span className="flex items-center gap-2 text-micro text-muted-tertiary">
          ↵ to send
          <span className="flex size-7 items-center justify-center rounded-xl bg-accent text-accent-foreground opacity-40">
            <ArrowUp className="size-4" aria-hidden />
          </span>
        </span>
      </div>
    </div>
  );
}
