/**
 * Whose a routine's work is: a routine that reaches only its owner is theirs alone, and so are the
 * conversations its runs work in, which carry them as their owner (`thread.created_by`) from the start. Its question
 * keeps no author, so a run still reads the workspace's knowledge only (never its owner's memory).
 */
import { type SQL, sql } from "@opendash/db";

/** The owner of this routine run's routine when it reaches only them, else null: a private routine's thread's owner. */
export const privateOwnerOf = (orgId: string, routineRunId: string): SQL => sql`(
  select ro.owner_id from app.routine_run rr
  join app.routine ro on ro.org_id = rr.org_id and ro.id = rr.routine_id
  where rr.org_id = ${orgId} and rr.id = ${routineRunId}
    and ro.key is null and jsonb_array_length(ro.slack) = 0
    and not exists (select 1 from unnest(ro.user_ids) u where u <> ro.owner_id))`;
