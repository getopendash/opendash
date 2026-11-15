/**
 * Resolves the theme CSS into plain colour values per theme (light / dark).
 *
 * Inputs, in cascade order (later wins, matching the real stylesheet):
 *   1. HeroUI's default theme variables      (@heroui/styles/themes/default/variables.css)
 *   2. the theme                             (packages/ui/src/styles/opendash-theme.css)
 *   3. OpenDash semantic aliases               (packages/ui/src/styles/tokens.css)
 *
 * It understands exactly what those files use: custom properties, var() with fallbacks, color-mix() in
 * oklab / oklch / srgb (with premultiplied alpha, as CSS specifies), and any colour culori can parse.
 * Consumers that can't read CSS variables (ECharts, email, PPTX, the contrast test) use the generated output.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Color, converter, formatHex, formatHex8, parse } from "culori";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const sources = {
  heroui: require.resolve("@heroui/styles/themes/default/variables.css"),
  design: path.resolve(here, "../src/styles/opendash-theme.css"),
  semantic: path.resolve(here, "../src/styles/tokens.css"),
} as const;

export type ThemeName = "light" | "dark";
type Block = { selectors: string[]; decls: Array<[string, string]> };

const LIGHT = new Set([":root", ":host", ".light", ".default", '[data-theme="light"]', '[data-theme="default"]']);
const DARK = new Set([":root", ":host", ".dark", '[data-theme="dark"]']);

/** Minimal block parser: returns innermost rule blocks with their custom-property declarations. */
export function parseBlocks(css: string): Block[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  const stack: Array<{ prelude: string; decls: Array<[string, string]> }> = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "{") {
      stack.push({ prelude: buf.trim(), decls: [] });
      buf = "";
    } else if (ch === "}") {
      const top = stack.pop();
      const tail = buf.trim();
      if (top && tail) pushDecl(top.decls, tail);
      buf = "";
      if (top && top.decls.length > 0 && !top.prelude.startsWith("@")) {
        out.push({ selectors: top.prelude.split(",").map((s) => s.replace(/\s+/g, " ").trim()), decls: top.decls });
      }
    } else if (ch === ";") {
      const top = stack.at(-1);
      if (top) pushDecl(top.decls, buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

function pushDecl(decls: Array<[string, string]>, raw: string) {
  const m = /^(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(raw);
  if (m?.[1] && m[2]) decls.push([m[1], m[2].trim()]);
}

/** Custom properties in effect on the root element for a theme, in cascade order. */
export function environment(theme: ThemeName, files: string[] = Object.values(sources)): Map<string, string> {
  const env = new Map<string, string>();
  const wanted = theme === "light" ? LIGHT : DARK;
  for (const file of files) {
    for (const block of parseBlocks(readFileSync(file, "utf8"))) {
      if (block.selectors.some((s) => s.includes("vibrant"))) continue;
      if (!block.selectors.some((s) => wanted.has(s))) continue;
      for (const [name, value] of block.decls) env.set(name, value);
    }
  }
  return env;
}

/** Substitute var() references recursively. */
export function substitute(value: string, env: Map<string, string>, depth = 0): string {
  if (depth > 32) throw new Error(`var() cycle while resolving: ${value}`);
  let result = "";
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf("var(", i);
    if (start < 0) {
      result += value.slice(i);
      break;
    }
    result += value.slice(i, start);
    const end = matchParen(value, start + 3);
    const inner = value.slice(start + 4, end);
    const comma = topLevelIndex(inner, ",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim();
    const own = env.get(name);
    const chosen = own ?? fallback;
    if (chosen === undefined) throw new Error(`Unresolved ${name}`);
    result += substitute(chosen, env, depth + 1);
    i = end + 1;
  }
  return result;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced parentheses: ${s}`);
}

function topLevelIndex(s: string, needle: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (depth === 0 && s[i] === needle) return i;
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

type Space = "oklab" | "oklch" | "rgb";
const converters = { oklab: converter("oklab"), oklch: converter("oklch"), rgb: converter("rgb") };
const toSpace = (space: Space, color: Color) =>
  (converters[space] as (c: Color) => Color)(color) as unknown as Record<string, number | undefined>;

/** Evaluate a (var-free) colour expression, or return undefined if it isn't a colour. */
export function evaluateColor(expr: string): Color | undefined {
  const s = expr.trim();
  if (s.startsWith("color-mix(")) return colorMix(s.slice("color-mix(".length, matchParen(s, 9)));
  return parse(s) ?? undefined;
}

function colorMix(args: string): Color | undefined {
  const [spaceArg, a, b] = splitTopLevel(args);
  if (!spaceArg || !a || !b) return undefined;
  const spaceName = spaceArg.replace(/^in\s+/, "").trim();
  const space: Space = spaceName === "oklch" ? "oklch" : spaceName === "srgb" ? "rgb" : "oklab";
  const stop = (part: string) => {
    const m = /^([\s\S]*?)\s+([\d.]+)%$/.exec(part);
    return m?.[1] && m[2] ? { color: m[1], pct: Number(m[2]) } : { color: part, pct: undefined };
  };
  const s1 = stop(a);
  const s2 = stop(b);
  let p1 = s1.pct;
  let p2 = s2.pct;
  if (p1 === undefined && p2 === undefined) {
    p1 = 50;
    p2 = 50;
  } else if (p1 === undefined) p1 = 100 - (p2 ?? 0);
  else if (p2 === undefined) p2 = 100 - p1;
  const sum = (p1 ?? 0) + (p2 ?? 0);
  if (sum <= 0) return undefined;
  const alphaScale = sum < 100 ? sum / 100 : 1;
  const w1 = (p1 ?? 0) / sum;
  const w2 = (p2 ?? 0) / sum;
  const c1 = evaluateColor(s1.color);
  const c2 = evaluateColor(s2.color);
  if (!c1 || !c2) return undefined;
  const x = toSpace(space, c1);
  const y = toSpace(space, c2);
  const ax = x.alpha ?? 1;
  const ay = y.alpha ?? 1;
  const alpha = ax * w1 + ay * w2;
  const channels = space === "oklab" ? ["l", "a", "b"] : space === "oklch" ? ["l", "c", "h"] : ["r", "g", "b"];
  const mixed: Record<string, number | string> = { mode: space };
  for (const ch of channels) {
    const vx = x[ch] ?? 0;
    const vy = y[ch] ?? 0;
    if (ch === "h") {
      // Hue isn't premultiplied; interpolate the shorter arc. Achromatic sides take the other hue.
      const hx = x.c ? vx : vy;
      const hy = y.c ? vy : vx;
      let d = hy - hx;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      mixed[ch] = (hx + d * w2 + 360) % 360;
    } else {
      const premul = vx * ax * w1 + vy * ay * w2;
      mixed[ch] = alpha === 0 ? 0 : premul / alpha;
    }
  }
  mixed.alpha = alpha * alphaScale;
  return mixed as unknown as Color;
}

export function toHex(color: Color): string {
  const alpha = color.alpha ?? 1;
  return alpha < 1 ? formatHex8(color) : formatHex(color);
}

/** All colour-valued custom properties for a theme, resolved to hex. */
export function resolveColors(theme: ThemeName, files?: string[]): Record<string, string> {
  const env = environment(theme, files);
  const out: Record<string, string> = {};
  for (const name of [...env.keys()].sort()) {
    let value: string;
    try {
      value = substitute(env.get(name) ?? "", env);
    } catch {
      continue;
    }
    const color = evaluateColor(value);
    if (color) out[name.slice(2)] = toHex(color);
  }
  return out;
}

export function renderModule(): string {
  const light = resolveColors("light");
  const dark = resolveColors("dark");
  const body = (o: Record<string, string>) =>
    Object.entries(o)
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join("\n");
  return `// Generated by packages/ui/scripts/build-tokens.ts. Do not edit; run \`pnpm --filter @opendash/ui tokens\`.
// Sources: @heroui/styles default theme, packages/ui/src/styles/opendash-theme.css, packages/ui/src/styles/tokens.css.
// Use these only where CSS variables can't be read (charts rendered on the server, email, PPTX, tests).

export const tokens = {
  light: {
${body(light)}
  },
  dark: {
${body(dark)}
  },
} as const;

export type ThemeName = keyof typeof tokens;
export type ColorToken = keyof (typeof tokens)["light"];
`;
}
