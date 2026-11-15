import { buttonVariants } from "@heroui/react";
import type { SkillSpec } from "@opendash/core";
import { isUuid } from "@opendash/db";
import { CodeBlock } from "@opendash/ui";
import { ListChecks, MessageSquare, Play } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ContextActions } from "@/components/context/context-actions";
import { ContextStatus } from "@/components/context/context-tables";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { canVerify } from "@/lib/knowledge";
import { skillFor } from "@/lib/skills";

export const metadata: Metadata = { title: "Skill · OpenDash" };

/** A skill's page: when the analyst uses it, its steps, the answers that followed it, its versions. */
export default async function SkillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  const found = await skillFor(viewer.ctx.orgId, viewer.user.id, id);
  if (!found) notFound();
  const { item, answers, followed } = found;
  const spec = (item.released?.spec ?? item.spec) as SkillSpec;
  const shown = item.released ?? { version: item.version, body: item.body };
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Skills", href: "/knowledge/skills" },
          { label: item.title },
        ]}
        action={
          canVerify(viewer.role) ? (
            <span className="flex items-center gap-1.5">
              {/* Try now: a question with this version attached, before or after it's approved. */}
              <Link
                href={`/ask/new?attach=skill:${item.id}@${item.version}`}
                title={
                  item.releasedVersion === item.version
                    ? "Ask a question with this skill attached."
                    : `Ask a question following version ${item.version}, before it's approved.`
                }
                className={`${buttonVariants({ size: "sm", variant: "outline" })} gap-1`}
              >
                <Play className="size-3.5" aria-hidden />
                Try now
              </Link>
              <ContextActions
                id={item.id}
                version={item.version}
                status={item.status}
                kind="skills"
                title={item.title}
              />
            </span>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-8 @5xl/page:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <header className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-secondary">
                <ListChecks className="size-5" aria-hidden />
              </span>
              <div className="flex flex-col gap-1">
                <h1 className="flex flex-wrap items-center gap-2 text-display">
                  {item.title}
                  <ContextStatus c={item} />
                </h1>
                <p className="text-small text-muted">
                  Skill · version {item.releasedVersion ?? item.version}
                  {item.releasedVersion ? "" : ", not approved yet"} · followed in {followed}{" "}
                  {followed === 1 ? "answer" : "answers"} in the last 30 days
                  {item.released ? ` · version ${item.version} waits for approval` : ""}
                </p>
              </div>
            </header>
            <section className="flex flex-col gap-1.5">
              <h2 className="text-small font-medium text-muted">Use it when</h2>
              <p className="text-body">{spec.description}</p>
            </section>
            <section className="flex flex-col gap-1.5">
              <h2 className="text-small font-medium text-muted">
                What to do{item.released ? ` (version ${shown.version}, the one the analyst follows)` : ""}
              </h2>
              <CodeBlock code={shown.body} label="Copy" wrap />
            </section>
          </div>
          <aside className="flex shrink-0 flex-col gap-7 @5xl/page:w-80">
            <section className="flex flex-col gap-2">
              <h2 className="text-small font-medium text-muted">Followed in</h2>
              {answers.length ? (
                <ul className="flex flex-col gap-1">
                  {answers.map((a) => (
                    <li key={a.threadId}>
                      <Link
                        href={`/ask/${a.threadId}`}
                        className="flex gap-2.5 rounded-xl px-2 py-1.5 hover:bg-default"
                      >
                        <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-tertiary" aria-hidden />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-body">{a.title}</span>
                          <span className="text-small text-muted-tertiary">
                            {shortDate(a.at)} · version {a.version}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-small text-muted-tertiary">
                  {item.releasedVersion
                    ? "No answer you can open has followed it yet."
                    : "Answers follow it once it's approved."}
                </p>
              )}
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="text-small font-medium text-muted">Versions</h2>
              <ul className="flex flex-col">
                {item.versions.map((v) => (
                  <li key={v.version} className="flex items-baseline gap-3 border-b border-border py-2 text-body">
                    <span className="w-20 shrink-0 font-medium">Version {v.version}</span>
                    <span className="flex-1 text-muted">
                      {v.changeNote ?? (v.version === 1 ? "Written" : "Edited")}
                    </span>
                    <span className="text-small text-muted-tertiary">{shortDate(v.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}
