/**
 * An error as OpenDash's logs keep it: the database's own message and code, never a failed query's SQL or its
 * parameters, which carry a source's values (a refused column's, up to 5,000 of them) and ids.
 */
export function loggableError(error: unknown): string {
  const cause = (error as { cause?: { message?: unknown; code?: unknown } } | null)?.cause;
  if (cause && typeof cause.message === "string") {
    return `${cause.message}${typeof cause.code === "string" ? ` (${cause.code})` : ""}`.slice(0, 300);
  }
  const text = error instanceof Error ? error.message : String(error);
  return (/^Failed query:/.test(text) ? "A query failed." : (text.split("\nparams:")[0] ?? "")).slice(0, 300);
}

/**
 * A V8 stack frame: "at", then where it ends, a file's line and column ("(/app/x.js:12:5)", "node:internal/…:1:2") or a
 * frame with no file ("(<anonymous>)", "(native)", "(index 0)"). A message's own indented lines, a failed query's SQL
 * like "  at time zone 'UTC'", don't end that way.
 */
const FRAME = /^\s+at .+(?::\d+:\d+\)?|\((?:<anonymous>|native|index \d+)\))$/;

/**
 * Where an error was thrown, for a log line: its stack's frames (function, file and line), at most `max` of them.
 * Never the message the stack starts with (a failed query's SQL and parameters with it): what comes before the message's
 * end is cut, and of what's left only lines shaped like a frame are kept.
 */
export function loggableStack(error: unknown, max = 8): string[] {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== "string") return [];
  const message = (error as { message?: unknown }).message;
  // The stack opens with "Name: message"; the name is short, so the message starts within the first few characters.
  const at = typeof message === "string" && message ? stack.indexOf(message) : -1;
  const frames = at >= 0 && at <= 200 ? stack.slice(at + (message as string).length) : stack;
  return frames
    .split("\n")
    .filter((line) => FRAME.test(line))
    .slice(0, max)
    .map((line) => line.trim().slice(0, 300));
}
