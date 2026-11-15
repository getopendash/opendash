"use client";

import { Button, Chip, Skeleton } from "@heroui/react";
import type { mcp } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { useQuery } from "@tanstack/react-query";
import { Info, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { apiQueries } from "@/lib/api";
import { AddServerDialog } from "./add-server-dialog";
import { AccessTag, AuthTag, ServerGlyph, useReturnedSignIn } from "./shared";

type Tone = "success" | "warning" | "danger" | "default";

/** Where a server stands, for its row: whether calls can run, and what's in the way when they can't. */
export function serverStatus(s: mcp.ServerView): { label: string; tone: Tone } {
  if (s.status === "disabled") return { label: "Off", tone: "default" };
  if (s.auth === "none") return { label: "Live", tone: "success" };
  if (s.access === "shared") {
    if (!s.shared) return { label: s.auth === "apikey" ? "Needs a key" : "Needs sign-in", tone: "warning" };
    if (s.shared.status === "wrong_account") return { label: "Different account", tone: "warning" };
    if (s.shared.status === "reconnect") {
      return { label: s.auth === "apikey" ? "Key refused" : "Sign in again", tone: "danger" };
    }
    return { label: "Live", tone: "success" };
  }
  if (!s.toolsListedAt) return { label: "Tools not listed", tone: "warning" };
  return { label: "Live", tone: "success" };
}

/** Its tools in a line: "8 · 4 read" (or what's waiting). */
function toolsLine(s: mcp.ServerView): string {
  if (!s.toolsListedAt) return "–";
  const parts = [`${s.tools.total}`, `${s.tools.always} run freely`];
  if (s.tools.changed) parts.push(`${s.tools.changed} changed`);
  return parts.join(" · ");
}

/** Whose account its calls use, in a line under the tag. */
function accountLine(s: mcp.ServerView): string {
  if (s.auth === "none") return "No account needed";
  if (s.access === "shared") return s.shared?.account ? s.shared.account : "Not connected yet";
  if (!s.people) return "";
  const { connected, attention } = s.people;
  const who = `${connected} ${connected === 1 ? "person" : "people"} connected`;
  return attention ? `${who} · ${attention} need to again` : who;
}

const col = dataColumns<mcp.ServerView>();
const columns = col.columns([
  col.accessor("name", {
    header: "Server",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ row: { original: s } }) => (
      <Link href={`/settings/connections/${s.id}`} className="flex min-w-0 items-center gap-3 hover:underline">
        <ServerGlyph name={s.name} host={s.host} />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{s.name}</span>
          <span className="truncate font-mono text-micro text-muted-tertiary">{s.host}</span>
        </span>
      </Link>
    ),
  }),
  col.accessor("auth", {
    header: "Sign-in",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: s } }) => <AuthTag auth={s.auth} />,
  }),
  col.accessor("access", {
    header: "Whose account",
    meta: { className: "hidden whitespace-nowrap @3xl/page:table-cell" },
    cell: ({ row: { original: s } }) => (
      <span className="flex flex-col items-start gap-1">
        <AccessTag access={s.access} />
        <span className="text-micro text-muted-tertiary">{accountLine(s)}</span>
      </span>
    ),
  }),
  col.accessor((s) => toolsLine(s), {
    id: "tools",
    header: "Tools",
    meta: { className: "hidden whitespace-nowrap @4xl/page:table-cell" },
    cell: ({ getValue }) => <span className="text-muted">{getValue()}</span>,
  }),
  col.accessor((s) => serverStatus(s).label, {
    id: "status",
    header: "Status",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: s } }) => {
      const status = serverStatus(s);
      return (
        <span className="flex items-center gap-1.5">
          <Chip size="sm" variant="soft" color={status.tone}>
            {status.label}
          </Chip>
          {s.tools.changed ? (
            <Chip size="sm" variant="soft" color="warning">
              Tools changed
            </Chip>
          ) : null}
        </span>
      );
    },
  }),
]);

/**
 * Settings → Connections: every MCP server approved here, how each signs people in and whose account its
 * calls use, and adding one. Owners and admins.
 */
export function ConnectionsSettings() {
  useReturnedSignIn();
  const servers = useQuery(apiQueries.mcp.servers.queryOptions());
  const [adding, setAdding] = useState(false);
  const table = useDataTable({ columns, data: servers.data ?? [], getRowId: (s) => s.id });

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Connections</h1>
          <p className="max-w-reading text-body text-muted">
            MCP servers the analyst and dashboards can use. Each one signs in its own way; you choose whether everyone
            uses their own account or one account is shared.
          </p>
        </div>
        <Button size="sm" onPress={() => setAdding(true)}>
          <Plus className="size-3.5" aria-hidden />
          Add a server
        </Button>
      </div>
      {!servers.data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : servers.data.length ? (
        <DataTable table={table} label="Servers" />
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-border px-6 py-12 text-center">
          <p className="text-body font-medium">No servers yet</p>
          <p className="max-w-sm text-small text-muted">
            Paste a server's address and OpenDash works out how it signs people in: OAuth, an API key, or nothing.
          </p>
          <Button size="sm" variant="outline" className="mt-2" onPress={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add a server
          </Button>
        </div>
      )}
      <p className="flex max-w-reading items-start gap-1.5 text-small text-muted-tertiary">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Remote servers only (HTTP). OpenDash never runs a command on its own machines to start a server. People see
        their own connections in Settings → My connections.
      </p>
      {adding ? <AddServerDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
