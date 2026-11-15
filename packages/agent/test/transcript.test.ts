// A conversation that changes model or provider between questions: reasoning goes back only the way it came, and other
// routes' metadata is stripped, so the next one gets the turns without what it can't read. Parts committed since
// then carry their route; parts from before it came by the maker's own API their metadata is named for.

import { BLOCK_MARK, NOTE_MARK } from "@opendash/core";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { forRoute } from "../src";
import { tagged } from "../src/harness/transcript";
import { withBlock } from "../src/instructions/context";

const turns: ModelMessage[] = [
  { role: "user", content: "How did MRR change last month?" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Use the metric.", providerOptions: { anthropic: { signature: "sig-a" } } },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "metric_query",
        input: { metrics: ["mrr"] },
        providerOptions: { anthropic: { caller: "x" } },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "metric_query",
        output: { type: "json", value: { alias: "q1" } },
      },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "reasoning", text: "Thinking only.", providerOptions: { anthropic: { signature: "sig-b" } } }],
  },
  { role: "user", content: "And for Starter?" },
];

describe("a transcript from before parts carried their route", () => {
  it("leaves it unchanged for the provider that produced it", () => {
    expect(forRoute(turns, "anthropic")).toEqual(turns);
  });

  it("drops the other provider's reasoning and metadata, keeping the turns, calls and results", () => {
    const openai = forRoute(turns, "openai");
    expect(openai).toHaveLength(4);
    expect(openai[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "metric_query", input: { metrics: ["mrr"] } }],
    });
    expect(openai[2]?.role).toBe("tool");
    // A turn that was only reasoning has nothing left, so it's gone.
    expect(openai.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  it("keeps a part's own provider's metadata and drops the rest", () => {
    const mixed: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hi", providerOptions: { google: { thoughtSignature: "g" }, anthropic: { x: 1 } } },
          { type: "reasoning", text: "g thinks", providerOptions: { google: { thoughtSignature: "g2" } } },
        ],
      },
    ];
    expect(forRoute(mixed, "google")).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hi", providerOptions: { google: { thoughtSignature: "g" } } },
          { type: "reasoning", text: "g thinks", providerOptions: { google: { thoughtSignature: "g2" } } },
        ],
      },
    ]);
  });
});

describe("a transcript whose parts carry their route", () => {
  // Claude through Bedrock signs its thinking under `anthropic` too: only the route tells them apart.
  const via = (options: Record<string, unknown>) => tagged(options, "bedrock") as never;
  const viaBedrock: ModelMessage[] = [
    { role: "user", content: "How did MRR change last month?" },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Use the metric.",
          providerOptions: via({ anthropic: { signature: "s" } }),
        },
        { type: "text", text: "MRR went up.", providerOptions: via({ anthropic: { citations: [] } }) },
      ],
    },
  ];

  it("goes back whole the way it came", () => {
    expect(forRoute(viaBedrock, "bedrock")).toEqual(viaBedrock);
  });

  it("goes to Anthropic's own API without Bedrock's signed thinking or its metadata", () => {
    expect(forRoute(viaBedrock, "anthropic")[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "MRR went up.", providerOptions: { opendash: { route: "bedrock" } } }],
    });
  });

  it("keeps OpenDash's own marks on a part it tags", () => {
    expect(tagged({ opendash: { note: true }, openai: { id: "r1" } }, "openai")).toEqual({
      opendash: { note: true, route: "openai" },
      openai: { id: "r1" },
    });
    expect(tagged(undefined, "gateway")).toEqual({ opendash: { route: "gateway" } });
  });
});

describe("the question's own context", () => {
  it("goes with the person's last message, never a note from OpenDash after it", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "How did MRR change last month?" },
      { role: "assistant", content: [{ type: "text", text: "MRR went up." }] },
      {
        role: "user",
        content: "(OpenDash) The run needs to end with the answer tool. Call it now.",
        providerOptions: NOTE_MARK,
      },
    ];
    const out = withBlock(messages, '<context source="your memory">x</context>');
    expect(JSON.stringify(out[0])).toContain("your memory");
    expect(out[2]).toEqual(messages[2]);
    expect(withBlock(messages, "")).toBe(messages);
  });

  it("knows a note by where it came from, never by its words: a question can start like one", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "(OpenDash) what does this tag in my export mean?" }];
    expect(JSON.stringify(withBlock(messages, "Today is 2026-10-15."))).toContain("Today is 2026-10-15.");
  });

  it("is a message of its own when there's no question to go with", () => {
    expect(withBlock([], "The insight: MRR fell.")).toEqual([
      { role: "user", content: [{ type: "text", text: "The insight: MRR fell.", providerOptions: BLOCK_MARK }] },
    ]);
  });
});
