"use client";

import { Button, buttonVariants, Chip, Radio, RadioGroup } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CLICKHOUSE_PLAYGROUND_DOCS, CLICKHOUSE_PLAYGROUND_PATH } from "./playground";
import { type SourceKind, SourceTile } from "./source-tile";

const SOURCES: { kind: SourceKind; name: string; description: string; available: boolean }[] = [
  {
    kind: "postgres",
    name: "PostgreSQL",
    description: "Postgres 12+, including Neon, Supabase, RDS and Cloud SQL",
    available: true,
  },
  { kind: "mysql", name: "MySQL", description: "MySQL 8.4 and later, self-hosted or managed", available: true },
  { kind: "clickhouse", name: "ClickHouse", description: "ClickHouse Cloud or self-hosted, 24.3+", available: true },
  { kind: "snowflake", name: "Snowflake", description: "Key-pair or password auth, any edition", available: false },
  { kind: "bigquery", name: "BigQuery", description: "Service account with BigQuery Data Viewer", available: false },
];

/**
 * Pick the kind of database. PostgreSQL, MySQL and ClickHouse are wired up; the rest say so instead of failing later.
 * Without a database at hand, ClickHouse's public playground is one step away.
 */
export function SourcePicker() {
  const router = useRouter();
  const [kind, setKind] = useState<string>("postgres");
  return (
    <div className="flex flex-col gap-6">
      <RadioGroup aria-label="Database" value={kind} onChange={setKind} className="choice-cards gap-2">
        {SOURCES.map((source) => (
          <Radio key={source.kind} value={source.kind} isDisabled={!source.available}>
            <Radio.Content className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface p-3 transition-colors data-disabled:cursor-not-allowed data-focus-visible:ring-2 data-focus-visible:ring-focus data-hovered:bg-surface-secondary data-selected:border-accent data-selected:bg-accent-soft">
              <SourceTile kind={source.kind} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-body font-medium text-foreground">
                  {source.name}
                  {source.available ? null : (
                    <Chip size="sm" variant="soft">
                      Soon
                    </Chip>
                  )}
                </span>
                <span className="text-small text-muted">{source.description}</span>
              </span>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
            </Radio.Content>
          </Radio>
        ))}
      </RadioGroup>
      <div className="flex justify-end">
        <Button size="lg" onPress={() => router.push(`/data/sources/new/${kind}`)}>
          Continue
        </Button>
      </div>
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
        <SourceTile kind="clickhouse" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body font-medium text-foreground">
            No database at hand? Try ClickHouse's playground
          </span>
          <span className="text-small text-muted">
            Public sample datasets to play around with: house prices, GitHub events, taxi trips and more.{" "}
            <a href={CLICKHOUSE_PLAYGROUND_DOCS} target="_blank" rel="noreferrer" className="text-link hover:underline">
              About the datasets
            </a>
          </span>
        </span>
        <Link href={CLICKHOUSE_PLAYGROUND_PATH} className={buttonVariants({ size: "sm", variant: "outline" })}>
          Use the playground
        </Link>
      </div>
    </div>
  );
}
