/**
 * What in an App's code looks generated: findings the save hands back for the analyst to fix, never a
 * refusal (none of them needs to block a save). Read from the class names Tailwind's scanner finds in each
 * file, a token at a time: a coloured stripe on one edge, Tailwind's own colours, gradients, big soft corners, heavy
 * shadows, uppercase letter-spaced labels; and a ring gauge drawn in SVG. app-design's anti-slop.md says what instead.
 */
import { candidatesOf } from "./css";

export interface LookFinding {
  file: string;
  message: string;
}

/** Tailwind's own colour families: an App uses the theme's tokens instead. */
const PALETTE = new Set(
  "red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose slate gray zinc neutral stone".split(
    " ",
  ),
);
/** Utilities that take a colour. */
const COLOURED = new Set([
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
  "from",
  "via",
  "to",
  "divide",
  "outline",
  "shadow",
  "decoration",
]);
const EDGES = new Set(["l", "r", "s", "e"]);
const BIG_RADIUS = new Set(["xl", "2xl", "3xl", "4xl"]);
const HEAVY_SHADOW = new Set(["shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl"]);

/** A class without its variants (hover:, @3xl:, md:) or its important mark. */
const utilityOf = (token: string) => (token.split(":").at(-1) ?? token).replace(/^!|!$/g, "");

/** What one class says about the look, if it's one of the generated tells. */
function tellOf(utility: string): string | null {
  const parts = utility.split("-");
  const [head = "", second = "", third = ""] = parts;
  if (head === "border" && EDGES.has(second) && third && third !== "0" && third !== "1")
    return `${utility}: a thick stripe on one edge; rows in a divide-y list, a tone as a dot and a word`;
  if (COLOURED.has(head) && PALETTE.has(second) && /^\d{2,3}$/.test(third))
    return `${utility}: Tailwind's own colours; the theme's tokens (bg-surface, text-muted, text-danger-soft-foreground…)`;
  if ((head === "bg" && ["linear", "radial", "conic", "gradient"].includes(second)) || utility === "bg-clip-text")
    return `${utility}: a gradient; the surface and a hairline`;
  if (head === "rounded" && (BIG_RADIUS.has(second) || BIG_RADIUS.has(third)))
    return `${utility}: big soft corners; rounded-md on fields and buttons, panes square`;
  if (HEAVY_SHADOW.has(utility) || utility.startsWith("backdrop-blur"))
    return `${utility}: heavy shadow or blur; hairlines (border-border)`;
  return null;
}

/** The generated tells in an App's files, a finding for each kind in each file, at most `max`. */
export function lookFindings(files: Record<string, string>, max = 12): LookFinding[] {
  const out: LookFinding[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
    const utilities = candidatesOf({ [file]: source }).map(utilityOf);
    const seen = new Set<string>();
    for (const u of utilities) {
      const tell = tellOf(u);
      const kind = tell?.split(":")[1];
      if (!tell || !kind || seen.has(kind)) continue;
      seen.add(kind);
      out.push({ file, message: tell });
    }
    if (
      utilities.includes("uppercase") &&
      utilities.some((u) => u.startsWith("tracking-wide") || u.startsWith("tracking-["))
    )
      out.push({
        file,
        message: "uppercase with letter-spacing: an eyebrow label; a heading in sentence case, text-sm font-semibold",
      });
    if (source.includes("<circle") && (source.includes("strokeDasharray") || source.includes("strokeDashoffset")))
      out.push({ file, message: "an SVG ring or gauge for a number; the number in text with its comparison" });
  }
  return out.slice(0, max);
}
