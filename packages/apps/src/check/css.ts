/**
 * An App's CSS: Tailwind, compiled from the class names its own files use, its colours the
 * workspace's theme (so `bg-surface` or `text-muted` follow light and dark), then the App's own `/styles.css`. All in
 * memory, with no shell and nothing read but Tailwind's own stylesheets; the result goes inside the bundle, so its
 * hash covers the look too. A stylesheet may not load anything (`@import`, a `url()` that isn't data): the frame's
 * policy would block it anyway, and saying so here tells the analyst why.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Scanner } from "@tailwindcss/oxide";

const require = createRequire(import.meta.url);
const TAILWIND_DIR = path.dirname(require.resolve("tailwindcss/package.json"));
const { compile } = require("tailwindcss") as {
  compile(
    css: string,
    opts: {
      base: string;
      loadStylesheet(id: string, base: string): Promise<{ base: string; content: string; path: string }>;
    },
  ): Promise<{ build(candidates: string[]): string }>;
};

/** The App's stylesheet, at most this many characters (its own, before Tailwind's). */
export const STYLES_CHARS = 60_000;

/**
 * Tailwind's layers, its colours mapped to the frame's theme variables (the kit's names), and the frame's fonts. The
 * default palette stays too, for the rare colour the theme doesn't have.
 */
const INPUT = `@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css" layer(utilities);
@theme inline {
  --color-background: var(--background);
  --color-background-secondary: var(--background-secondary);
  --color-foreground: var(--foreground);
  --color-surface: var(--surface);
  --color-surface-secondary: var(--surface-secondary);
  --color-muted: var(--muted);
  --color-border: var(--border);
  --color-separator: var(--separator);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent-soft: var(--accent-soft);
  --color-accent-soft-foreground: var(--accent-soft-foreground);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft);
  --color-success-soft-foreground: var(--success-soft-foreground);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --color-warning-soft-foreground: var(--warning-soft-foreground);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-danger-soft-foreground: var(--danger-soft-foreground);
  --font-sans: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  --font-mono: var(--font-mono, ui-monospace, monospace);
}
`;

const stylesheet = async (id: string, base: string) => {
  const file =
    id === "tailwindcss"
      ? path.join(TAILWIND_DIR, "index.css")
      : id.startsWith("tailwindcss/")
        ? path.join(TAILWIND_DIR, id.slice("tailwindcss/".length))
        : path.resolve(base, id);
  // Only Tailwind's own files are ever read.
  if (!file.startsWith(TAILWIND_DIR + path.sep)) throw new Error(`Only Tailwind's stylesheets load: ${id}`);
  return { base: path.dirname(file), content: readFileSync(file, "utf8"), path: file };
};

/**
 * The class names an App's files may use, found by Tailwind's own scanner (the one its CLI and Vite plugin use), so a
 * class is found however it's written: an arbitrary value with commas (grid-cols-[minmax(0,1fr)_auto]), a variant, a
 * class built from strings. A hand-written pattern once split those, and their CSS never came.
 */
export function candidatesOf(files: Record<string, string>): string[] {
  const content = Object.entries(files).flatMap(([name, text]) => {
    const extension = name.split(".").pop() ?? "";
    return ["tsx", "ts", "css"].includes(extension) ? [{ content: text, extension }] : [];
  });
  return new Scanner({}).scanFiles(content);
}

/** What's wrong with the App's own stylesheet, as files: it loads nothing from anywhere. */
export function stylesProblems(css: string): string[] {
  const out: string[] = [];
  if (css.length > STYLES_CHARS) out.push(`styles.css is at most ${STYLES_CHARS} characters.`);
  if (/@import\b/i.test(css)) out.push("styles.css imports nothing: write the rules here, or use Tailwind classes.");
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!m[2]?.trim().toLowerCase().startsWith("data:"))
      out.push(`styles.css loads nothing from outside: url(${m[2]}) won't load in the App.`);
  }
  return out;
}

/** The App's CSS: Tailwind for the classes its files use, then its own stylesheets in path order. */
export async function appCss(files: Record<string, string>): Promise<string> {
  const compiler = await compile(INPUT, { base: TAILWIND_DIR, loadStylesheet: stylesheet });
  const tailwind = compiler.build(candidatesOf(files));
  const own = Object.keys(files)
    .filter((path) => path.endsWith(".css"))
    .sort()
    .map((path) => files[path])
    .join("\n");
  return own ? `${tailwind}\n${own}` : tailwind;
}
