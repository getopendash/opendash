/**
 * Mistakes in a tool call's input that code can fix without changing what it says. Each would otherwise
 * cost a model call to send back, and on a large source a model call is most of a run's cost. Two fixes, and nothing
 * else:
 *   - a string where the schema wants a list of strings becomes a one-item list (Haiku's `interpretation`, a chart's
 *     `y`): read from the tool's JSON schema, so it's one rule for every tool;
 *   - a list the tool says may be left out (its `emptyWhenMissing`: the answer's caveats) becomes empty when it is.
 * Everything else still goes back to the model: a missing interpretation would hide the readings applied, and a
 * missing status or text is the model's to write. Input that isn't JSON (a response cut off at its output limit) is
 * never repaired. The repaired call is what's saved, so the model sees it fixed next time; its result says what was
 * fixed, and the run's steps record it.
 */
import { InvalidToolInputError, type JSONSchema7, type ToolCallRepairFunction, type ToolSet } from "ai";
import { type AttemptScope, offered } from "./attempt";

/** One fix to a call's input: the field, and how it was read. */
export interface Repair {
  field: string;
  how: "listed" | "emptied";
}

type Schema = JSONSchema7;

const asSchema = (s: unknown): Schema | undefined => (s && typeof s === "object" ? (s as Schema) : undefined);

const isStringList = (s: Schema | undefined) => {
  const items = asSchema(s?.items);
  return s?.type === "array" && !Array.isArray(s.items) && items?.type === "string";
};

/** The value with each string put in a list where its schema wants a list of strings; what was fixed goes in `fixed`. */
function listed(value: unknown, schema: Schema | undefined, path: string, fixed: Repair[]): unknown {
  if (!schema) return value;
  if (typeof value === "string" && isStringList(schema)) {
    fixed.push({ field: path, how: "listed" });
    return [value];
  }
  if (Array.isArray(value)) {
    const items = asSchema(schema.items);
    return items && !Array.isArray(schema.items)
      ? value.map((v, i) => listed(v, items, `${path}[${i}]`, fixed))
      : value;
  }
  if (value && typeof value === "object" && schema.properties) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        listed(v, asSchema(schema.properties?.[k]), path ? `${path}.${k}` : k, fixed),
      ]),
    );
  }
  return value;
}

/** What the model is told of a repaired call, with its result. */
export function repairNote(fixed: Repair[]): string {
  const said = fixed.map((r) =>
    r.how === "listed" ? `${r.field} was text, read as a one-item list` : `${r.field} was missing, read as none`,
  );
  return `Its input was repaired before it ran: ${said.join("; ")}. Send lists as lists.`;
}

export function repairCalls(scope: AttemptScope): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, inputSchema, error }) => {
    if (!InvalidToolInputError.isInstance(error)) return null;
    const t = offered(scope, toolCall.toolName);
    if (!t) return null;
    let input: unknown;
    try {
      input = JSON.parse(toolCall.input);
    } catch {
      return null;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const fixed: Repair[] = [];
    const out = listed(input, asSchema(await inputSchema({ toolName: toolCall.toolName })), "", fixed) as Record<
      string,
      unknown
    >;
    for (const field of t.emptyWhenMissing ?? []) {
      if (out[field] !== undefined) continue;
      out[field] = [];
      fixed.push({ field, how: "emptied" });
    }
    if (!fixed.length) return null;
    // If the repaired input still doesn't fit, the SDK keeps the call invalid, and this is never read.
    scope.repaired.set(toolCall.toolCallId, fixed);
    return { ...toolCall, input: JSON.stringify(out) };
  };
}
