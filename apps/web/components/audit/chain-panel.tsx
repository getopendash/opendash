"use client";

import { Button, Chip, Dropdown, Label, toast } from "@heroui/react";
import type { AuditChainStatus, AuditVerifyResult } from "@opendash/core/enterprise";
import { Download, ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { verifyAuditChain } from "@/app/(app)/settings/audit-log/actions";
import { ago, count } from "@/lib/format";

const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

/**
 * The audit chain (ee/): how far it's sealed, its head, Verify, and the exports. "Intact" is said only after a Verify
 * that found it so; before that the panel says what's sealed.
 */
export function AuditChainPanel({ status, days, badge }: { status: AuditChainStatus; days: number; badge: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<AuditVerifyResult | null>(null);
  const verify = () =>
    start(async () => {
      const r = await verifyAuditChain();
      if ("message" in r) {
        toast.danger(r.message);
        return;
      }
      if (r.ok && r.agedOut) {
        toast.info(
          `Every sealed event has passed the retention, so there's nothing to walk. Compare the chain's head, ${short(r.head ?? "")}, with your last export's: it should match.`,
        );
        return;
      }
      if (r.ok && r.checked === 0) {
        toast.info("Nothing is sealed yet, so there's nothing to verify. Sealing runs each minute.");
        return;
      }
      setResult(r);
      if (r.ok)
        toast.success(
          `Verified ${count(r.checked, "event")}${r.fromSeq > 1 ? ` from event ${r.fromSeq}` : ""}. The chain is intact.`,
        );
      else toast.danger(`The chain breaks at event ${r.at.seq}: ${r.reason}`);
    });
  const exportUrl = (format: "csv" | "jsonl") => `/settings/audit-log/export?format=${format}&days=${days}`;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border px-5 py-4 @2xl/page:flex-row @2xl/page:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {result?.ok ? (
            <Chip size="sm" color="success" variant="soft">
              Chain intact
            </Chip>
          ) : result ? (
            <Chip size="sm" color="danger" variant="soft">
              Chain broken at event {result.at.seq}
            </Chip>
          ) : status.seq > 0 ? (
            <Chip size="sm" variant="soft">
              Sealed
            </Chip>
          ) : (
            <Chip size="sm" variant="soft">
              Nothing sealed yet
            </Chip>
          )}
          <span className="text-small text-muted tabular-nums">
            {count(status.total, "event")}
            {status.sealedAt ? ` · sealed up to ${ago(status.sealedAt, Date.now())}` : ""}
            {status.unsealed ? ` · ${status.unsealed} waiting for the next minute` : ""}
          </span>
          {badge ? (
            <Chip size="sm" color="accent" variant="soft">
              Enterprise
            </Chip>
          ) : null}
        </div>
        <p className="text-small text-muted">
          {status.head ? (
            <>
              Head <span className="font-mono">{short(status.head)}</span>. Every export carries it, so a copy lives
              outside the database.
            </>
          ) : (
            "Events are sealed into the chain each minute; its head shows here once the first one is."
          )}
          {status.purgedAt ? " The history before its purge was deleted; the chain starts again there." : ""}
        </p>
        {result && !result.ok ? <p className="text-small text-danger">{result.reason}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" isPending={pending} onPress={verify}>
          <ShieldCheck className="size-4" aria-hidden />
          Verify
        </Button>
        <Dropdown>
          <Button size="sm" variant="outline">
            <Download className="size-4" aria-hidden />
            Export
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-48">
            <Dropdown.Menu onAction={(key) => window.location.assign(exportUrl(key === "jsonl" ? "jsonl" : "csv"))}>
              <Dropdown.Item id="csv" textValue="CSV">
                <Label>CSV</Label>
              </Dropdown.Item>
              <Dropdown.Item id="jsonl" textValue="JSON Lines">
                <Label>JSON Lines</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </section>
  );
}
