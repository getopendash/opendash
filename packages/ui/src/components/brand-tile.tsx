import type { Brand } from "@opendash/tokens/brands";
import type { CSSProperties } from "react";

/**
 * A source's or a connected service's logo, as the landing site shows them: on a white tile with a hairline. A brand
 * with a full-colour logo (PostgreSQL, ClickHouse, Slack…, apps/web/public/logos) shows that; any other its mark in its
 * brand colour, from the sprite the web app serves (public/brands.svg, kept by the browser after its first use). A light
 * brand colour that wouldn't read on white (DuckDB, Mailchimp yellow) keeps its colour as the tile, the mark in ink. A
 * service OpenDash doesn't know shows its name's first letter on a quiet tile.
 */
const SIZES = {
  /** Inline, beside a line of text. */
  xs: { box: "size-4 rounded-[5px] text-[9px]", mark: "size-2.5" },
  sm: { box: "size-6 rounded-lg text-micro", mark: "size-3.5" },
  md: { box: "size-7 rounded-lg text-small", mark: "size-4" },
  /** Lists and forms of sources (the Source Option, 32). */
  source: { box: "size-8 rounded-xl text-small", mark: "size-[18px]" },
  lg: { box: "size-9 rounded-xl text-body", mark: "size-5" },
  /** A source's page header (44). */
  xl: { box: "size-11 rounded-2xl text-title", mark: "size-6" },
} as const;

export type BrandTileSize = keyof typeof SIZES;

export function BrandTile({
  brand,
  name,
  size = "md",
  sprite = "/brands.svg",
}: {
  brand: Brand | null;
  /** For the letter, when there's no mark. */
  name: string;
  size?: BrandTileSize;
  sprite?: string;
}) {
  const { box, mark } = SIZES[size];
  if (!brand) {
    return (
      <span
        aria-hidden
        className={`${box} flex shrink-0 items-center justify-center border border-border bg-surface-secondary font-mono font-semibold text-muted`}
      >
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      title={brand.title}
      className={`${box} flex shrink-0 items-center justify-center bg-(--brand-tile) ring-1 ring-border ring-inset`}
      style={{ "--brand-tile": brand.tile, "--brand-mark": brand.mark } as CSSProperties}
    >
      {brand.logo ? (
        <img src={brand.logo} alt="" className={`${mark} object-contain`} draggable={false} />
      ) : (
        <svg className={`${mark} text-(--brand-mark)`} fill="currentColor" aria-hidden>
          <use href={`${sprite}#${brand.key}`} />
        </svg>
      )}
    </span>
  );
}
