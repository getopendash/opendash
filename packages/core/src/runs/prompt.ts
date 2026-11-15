/**
 * What a run was sent, kept, so a run's input can be rebuilt after its events are dropped, and an
 * earlier question can be sent again exactly as it was (the prompt cache holds a conversation only while every earlier
 * question reads the same).
 *
 * Each layer is stored once, by its SHA-256, in app.prompt_text: the agent layer (it changes with a deploy), the
 * source layer (with a sync or a definition) and each question's own block (its date, the verified queries like it).
 * The run keeps its latest attempt's hashes, the tools it was offered by name, the verified queries its question's block
 * holds, and what the conversation layer held: what was attached, by id and version (it's checked again for whoever
 * asks, so it's rebuilt, never replayed), and how many of the asker's memories, never their text. The ledger writes it
 * (recordPrompt).
 */
import { createHash } from "node:crypto";
import { sql, type TenantTx } from "@opendash/db";

/** Something a run was given, by id and version: what was attached, a verified query its question's block holds. */
export interface GivenRef {
  kind: string;
  id: string;
  version?: number;
}

export interface SentPrompt {
  agent: string;
  source: string;
  /** What went with the question: its layer and its block, never the asker's memory. */
  question: string;
  /** The verified queries that block holds: it's sent again only while each is released at that version. */
  verified: GivenRef[];
  tools: string[];
  attached: GivenRef[];
  memories: number;
}

export interface RunPrompt extends Pick<SentPrompt, "verified" | "tools" | "attached" | "memories"> {
  /** The attempt that sent it. */
  attempt: number;
  /** Each layer's SHA-256 in app.prompt_text; a layer with nothing in it has none. */
  agent?: string;
  source?: string;
  question?: string;
}

export const PROMPT_LAYERS = ["agent", "source", "question"] as const;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The mark on a question's block, a part of its own: the fold drops it from a question folded away, and a call's size
 * leaves out the current question's (it's counted with what every call sends). Providers ignore it.
 */
export const BLOCK_MARK = { opendash: { block: true } } as const;

export const isBlock = (part: unknown): boolean =>
  (part as { providerOptions?: typeof BLOCK_MARK } | null)?.providerOptions?.opendash?.block === true;

/** A question with its own block as its last text part: one shape for the question being answered and one sent again. */
export function withBlockOn<M extends { role: string; content: unknown }>(m: M, block: string): M {
  if (!block) return m;
  const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown[]);
  return { ...m, content: [...parts, { type: "text", text: block, providerOptions: BLOCK_MARK }] };
}

/**
 * The block each earlier question in a thread was sent with, by its message id (this run's own is prepared anew). A
 * block holding a verified query an admin has since changed or removed isn't sent again: the question reads without it,
 * so a definition that no longer holds never reaches the model (the cache misses there, once).
 */
export async function blocksSent(
  tx: TenantTx,
  run: { orgId: string; id: string; threadId: string },
): Promise<Map<string, string>> {
  const rows = await tx.execute<{ message_id: string; text: string }>(sql`
    select r.input_message_id as message_id, p.text from app.run r
    join app.prompt_text p on p.org_id = r.org_id and p.sha256 = r.prompt->>'question'
    where r.org_id = ${run.orgId} and r.thread_id = ${run.threadId} and r.id <> ${run.id}
      and r.input_message_id is not null
      and not exists (
        select 1 from jsonb_array_elements(coalesce(r.prompt->'verified', '[]'::jsonb)) v
        where not exists (
          select 1 from app.context_item i
          where i.org_id = r.org_id and i.id = (v->>'id')::uuid and i.deleted_at is null
            and i.released_version = (v->>'version')::int))`);
  return new Map(rows.map((r) => [r.message_id, r.text]));
}
