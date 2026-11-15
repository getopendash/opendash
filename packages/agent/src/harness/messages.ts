/**
 * The messages each model call is sent, made the same within a pass as on a rebuild from the ledger. The
 * SDK answers a call that never ran (its input didn't parse, or its response was cut off at its output limit) with its
 * own error text; the ledger records ours, which says what to do. Within a pass the model would read the SDK's, and a
 * later pass or attempt ours: the conversation would change under the prompt cache, and a cut-off call would never be
 * told to send less. So before each step, each such result is replaced with what was recorded.
 */
import type { ModelMessage } from "ai";

type Part = { type: string; toolCallId?: string; output?: unknown };

/** The messages with each call that never ran answered as the ledger recorded it. */
export function asRecorded(messages: ModelMessage[], recorded: ReadonlyMap<string, string>): ModelMessage[] {
  if (!recorded.size) return messages;
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const content = (m.content as Part[]).map((p) => {
      const said = p.type === "tool-result" && p.toolCallId ? recorded.get(p.toolCallId) : undefined;
      return said === undefined ? p : { ...p, output: { type: "error-text", value: said } };
    });
    return { ...m, content } as ModelMessage;
  });
}
