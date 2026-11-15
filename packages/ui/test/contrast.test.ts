import { type ColorToken, type ThemeName, tokens } from "@opendash/tokens";
import { type Color, converter, parse, wcagContrast } from "culori";
import { describe, expect, it } from "vitest";

/**
 * The colour pairs measured in the Pencil token frame (WDFK2), plus OpenDash semantics.
 * AA = 4.5 (text), UI = 3.0 (large text, icons, outlines). Translucent colours are composited over `over`.
 */
type Pair = { fg: ColorToken; bg: ColorToken; min: 4.5 | 3; over?: ColorToken; usedFor: string };

const pairs: Pair[] = [
  { fg: "foreground", bg: "background", min: 4.5, usedFor: "body text on page" },
  { fg: "foreground", bg: "surface", min: 4.5, usedFor: "text on cards, panels, tables" },
  { fg: "muted", bg: "background", min: 4.5, usedFor: "secondary text" },
  { fg: "muted", bg: "surface", min: 4.5, usedFor: "secondary text on cards" },
  { fg: "muted", bg: "default", min: 4.5, usedFor: "inactive tab, secondary on chips" },
  { fg: "field-placeholder", bg: "field-background", min: 4.5, usedFor: "input placeholder" },
  { fg: "muted-tertiary", bg: "surface", min: 3, usedFor: "disabled text, decorative meta" },
  { fg: "accent-foreground", bg: "accent", min: 3, usedFor: "primary button label (UI only by design)" },
  { fg: "accent-foreground", bg: "accent-hover", min: 4.5, usedFor: "primary button, hover" },
  { fg: "link", bg: "surface", min: 4.5, usedFor: "links" },
  { fg: "accent-soft-foreground", bg: "accent-soft", over: "surface", min: 4.5, usedFor: "accent chip" },
  { fg: "accent-soft-foreground", bg: "default", min: 4.5, usedFor: "secondary button label" },
  { fg: "success-foreground", bg: "success", min: 4.5, usedFor: "solid success chip" },
  { fg: "success-soft-foreground", bg: "success-soft", over: "surface", min: 4.5, usedFor: "success chip" },
  { fg: "warning-foreground", bg: "warning", min: 4.5, usedFor: "solid warning chip" },
  { fg: "warning-soft-foreground", bg: "warning-soft", over: "surface", min: 4.5, usedFor: "stale / warning chip" },
  { fg: "danger-foreground", bg: "danger", min: 4.5, usedFor: "danger button" },
  { fg: "danger-soft-foreground", bg: "danger-soft", over: "surface", min: 4.5, usedFor: "error chip" },
  { fg: "focus", bg: "background", min: 3, usedFor: "focus ring" },
  { fg: "border-tertiary", bg: "surface", min: 3, usedFor: "checkbox / radio outline" },
  // OpenDash semantics
  { fg: "status-verified-foreground", bg: "status-verified-soft", over: "surface", min: 4.5, usedFor: "Verified" },
  { fg: "status-progress-foreground", bg: "status-progress-soft", over: "surface", min: 4.5, usedFor: "In progress" },
  { fg: "status-unverified-foreground", bg: "status-unverified-soft", min: 4.5, usedFor: "Unverified" },
  { fg: "status-stale-foreground", bg: "status-stale-soft", over: "surface", min: 4.5, usedFor: "Stale" },
  { fg: "status-failed-foreground", bg: "status-failed-soft", over: "surface", min: 4.5, usedFor: "Failed" },
  { fg: "status-error-foreground", bg: "status-error-soft", min: 4.5, usedFor: "Error" },
  { fg: "delta-good", bg: "surface", min: 4.5, usedFor: "good delta" },
  { fg: "delta-bad", bg: "surface", min: 4.5, usedFor: "bad delta" },
  { fg: "ref", bg: "surface", min: 4.5, usedFor: "traced number" },
];

const toRgb = converter("rgb");

function solid(theme: ThemeName, name: ColorToken, over?: ColorToken): Color {
  const color = parse(tokens[theme][name]);
  if (!color) throw new Error(`Not a colour: ${name}`);
  const alpha = color.alpha ?? 1;
  if (alpha >= 1) return color;
  const a = toRgb(color);
  const b = toRgb(solid(theme, over ?? "surface"));
  const mix = (x: number, y: number) => x * alpha + y * (1 - alpha);
  return { mode: "rgb", r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b) };
}

describe.each(["light", "dark"] as const)("%s theme contrast", (theme) => {
  it.each(pairs)("$fg on $bg ($usedFor) ≥ $min", ({ fg, bg, over, min }) => {
    const ratio = wcagContrast(solid(theme, fg, over ?? "surface"), solid(theme, bg, over));
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(min);
  });
});
