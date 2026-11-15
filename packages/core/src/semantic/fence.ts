/**
 * Text from data or from people, in a run's brief: fenced as data, and unable to close its fence or open
 * another one, as the agent's own fences do (agent/src/instructions/context.ts `inert`).
 */
export const inertText = (s: string) =>
  s
    .replace(/<\/?\s*context\b[^>]*>/gi, "[context tag removed]")
    .replace(/<\/?\s*skills?\b[^>]*>/gi, "[skill tag removed]");

export const dataFence = (source: string, text: string, trust: "data" | "admin" | "reported" = "data") =>
  `<context source="${inertText(source).replace(/"/g, "'")}" trust="${trust}">\n${inertText(text)}\n</context>`;
