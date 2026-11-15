import { BRAND_MARKS } from "@opendash/tokens/brand-marks";
import { type Brand, brandOfDialect, brandOfHost } from "@opendash/tokens/brands";
import type { SourceMark } from "../protocol";

/**
 * A source's mark for an App's frame, which draws it before the source's name under each piece: a database's by its
 * dialect, a connected service's by its address (its name only tells two marks apart at one address). The frame loads
 * nothing, so the path itself goes with the read.
 */
export function sourceMark(
  source: { dialect: string } | { url: string; name: string } | undefined,
): SourceMark | undefined {
  if (!source) return undefined;
  let brand: Brand | null = null;
  if ("dialect" in source) brand = brandOfDialect(source.dialect);
  else if (URL.canParse(source.url)) brand = brandOfHost(new URL(source.url).host, source.name);
  if (!brand) return undefined;
  const { viewBox, path } = BRAND_MARKS[brand.key];
  return { title: brand.title, viewBox, path, bg: brand.bg, fg: brand.fg, onWhite: brand.onWhite };
}
