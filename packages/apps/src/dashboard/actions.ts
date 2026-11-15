/**
 * A row's actions: a change in a service, made by the person pressing it with their own
 * account, after they confirm it on OpenDash's own dialog. Its arguments are what the dashboard says, literally, with
 * one thing filled in: the row's key, wherever an argument is exactly "{key}". Nothing else is ever filled in.
 */

/** The one slot an action's arguments have. */
export const KEY_SLOT = "{key}";
/** The most an action's arguments may be, as JSON. */
export const MAX_ACTION_ARGUMENTS = 4096;

/** What's wrong with an action's arguments, or null: a "{" in a string is only ever the whole "{key}". */
export function actionArgumentsProblem(args: unknown): string | null {
  if (JSON.stringify(args ?? {}).length > MAX_ACTION_ARGUMENTS) return "An action's arguments are at most 4 KB.";
  let bad: string | null = null;
  let slots = 0;
  const walk = (v: unknown) => {
    if (bad) return;
    if (typeof v === "string") {
      if (v === KEY_SLOT) slots++;
      else if (v.includes("{key"))
        bad = `"${v.slice(0, 40)}": the row's key goes in an argument of its own, exactly "{key}".`;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(args);
  if (bad) return bad;
  return slots ? null : 'An action names its row: one argument is exactly "{key}".';
}

/** The arguments with the row's key filled in (a copy; the key as it is, a string or a number). */
export function fillAction(args: Record<string, unknown>, key: string | number): Record<string, unknown> {
  const fill = (v: unknown): unknown =>
    v === KEY_SLOT
      ? key
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  return fill(args) as Record<string, unknown>;
}

/** A row's key as an action may send it: a short plain string or a finite number, or null. */
export function actionKey(key: unknown): string | number | null {
  if (typeof key === "number") return Number.isFinite(key) ? key : null;
  if (typeof key !== "string") return null;
  const k = key.trim();
  return k && k.length <= 200 && ![...k].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? k : null;
}
