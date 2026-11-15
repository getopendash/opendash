"use client";

import { Button, Checkbox, Modal, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { DraftCandidate } from "@opendash/core";
import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { candidateWhy, draftCapText } from "@/lib/source-drafts";

/**
 * Draft definitions. A source's tables and views, most useful first, the top ones ticked; up to `max`. It says
 * what OpenDash drafts and what the run costs at most before it starts a Modeler run over the ones picked.
 */
export function DraftPicker({
  connectionId,
  candidates,
  suggested,
  max,
  cost,
  label,
  primary,
}: {
  connectionId: string;
  candidates: DraftCandidate[];
  suggested: number;
  max: number;
  cost: { perTableUsd: number; baseUsd: number; leftUsd: number; budgetUsd: number };
  label: string;
  primary: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(
    () =>
      new Set(
        candidates
          .filter((c) => !c.modelled)
          .slice(0, suggested)
          .map((c) => c.name),
      ),
  );
  const draft = useMutation({
    mutationFn: () => api.proposals.draftSource({ connectionId, tables: [...selected] }),
  });
  const n = selected.size;
  const cap = draftCapText(n, cost);
  const start = () =>
    draft.mutate(undefined, {
      onSuccess: (r) => {
        setOpen(false);
        if (r.status === "held") {
          toast.warning("Background work's budget is spent or off, so the draft is held. An owner can raise it.");
        } else {
          toast.success(
            `OpenDash is drafting definitions from ${n} ${n === 1 ? "table" : "tables"}. They arrive in Knowledge → Proposals.`,
          );
        }
        router.refresh();
      },
      onError: (e) =>
        toast.danger(isDefinedError(e) ? (e as { message: string }).message : "Couldn't start the draft."),
    });
  return (
    <>
      <Button size="sm" variant={primary ? "primary" : "secondary"} onPress={() => setOpen(true)}>
        <Sparkles className="size-3.5" aria-hidden />
        {label}
      </Button>
      <Modal>
        <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>Draft definitions</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-5">
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-small font-medium">Tables and views</h3>
                  {candidates.length ? (
                    <ul className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border">
                      {candidates.map((c) => {
                        const on = selected.has(c.name);
                        return (
                          <li key={c.name}>
                            <Checkbox
                              isSelected={on}
                              isDisabled={!on && n >= max}
                              onChange={(next) =>
                                setSelected((prev) => {
                                  const s = new Set(prev);
                                  if (next) s.add(c.name);
                                  else s.delete(c.name);
                                  return s;
                                })
                              }
                              className="w-full px-2.5 py-1.5 hover:bg-default"
                            >
                              <Checkbox.Content className="w-full items-center">
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                                <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                                  <span className="truncate font-mono text-body">{c.name}</span>
                                  <span className="shrink-0 text-small text-muted">{candidateWhy(c)}</span>
                                </span>
                              </Checkbox.Content>
                            </Checkbox>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-body text-muted">This source has no tables or views learned yet.</p>
                  )}
                  <p className="text-small text-muted-tertiary">
                    Up to {max}. Most useful first: what your team's queries read, then what other tables join to, then
                    the largest.
                  </p>
                </section>
                <section className="flex flex-col gap-1">
                  <h3 className="text-small font-medium">What OpenDash drafts</h3>
                  <p className="text-small text-muted">
                    For each table, a dataset (its grain, key, time column, measures and joins) and a few metrics. Rows
                    a column marks as test, demo or sandbox are left out, and the draft says so.
                  </p>
                </section>
                <section className="flex flex-col gap-1">
                  <h3 className="text-small font-medium">Cost</h3>
                  <p className={`text-small ${cap.over ? "text-warning" : "text-muted"}`}>{cap.text}</p>
                </section>
                <p className="text-small text-muted-tertiary">
                  The drafts arrive in{" "}
                  <Link href="/knowledge/proposals" className="text-link hover:underline">
                    Knowledge → Proposals
                  </Link>
                  , each tested against your data. Nothing answers until an owner or admin approves it.
                </p>
              </Modal.Body>
              <Modal.Footer className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button size="sm" isPending={draft.isPending} isDisabled={n === 0} onPress={start}>
                  <Sparkles className="size-3.5" aria-hidden />
                  Draft from {n} {n === 1 ? "table" : "tables"}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
