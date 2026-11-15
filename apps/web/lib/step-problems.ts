/**
 * A step that didn't work, in the words a person wants while the analyst goes on: what it was about, not the source's
 * error text. The error itself stays one press away on the step. A message nothing here recognises is "Didn't work,
 * trying another way": most are what the analyst repairs on its next call.
 */
const WORDS: [RegExp, string][] = [
  [
    /isn't a table in this source's catalog|no such table|does not exist|doesn't exist|unknown table/i,
    "A table wasn't found",
  ],
  [/replacingmergetree/i, "Needed the latest versions"],
  [/no column|undefined_column|unknown column|unknown identifier|missing columns?/i, "A column wasn't found"],
  [/personal data|secret column/i, "Left out personal data"],
  [/timed? ?out|statement timeout|canceling statement/i, "Took too long"],
  [/syntax error|can't parse|cannot parse|not valid sql/i, "Rewriting the query"],
  [/isn't allowed|only runs select|read-only/i, "That kind of query isn't allowed"],
  [/permission denied|no access|not allowed to/i, "No access to that"],
  [/too many|row limit|result is too large|exceeds/i, "Too much to read at once"],
  [/connection|econn|could not connect|network|unreachable|terminated unexpectedly/i, "Couldn't reach the source"],
];

export const FALLBACK = "Didn't work, trying another way";

export function friendlyProblem(raw: string | undefined): string {
  const text = raw?.trim();
  if (!text) return FALLBACK;
  return WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? FALLBACK;
}
