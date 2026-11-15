// The marks of the services and databases OpenDash connects to, as one-colour paths on their brand colour, for every
// place a source or a connected service is named (settings, the Ask panel, the line under an App's piece in its sealed
// frame, which can't load a picture). Writes @opendash/tokens' brands.generated.ts (names and colours) and
// brand-marks.generated.ts (the paths, for the server), and apps/web/public/brands.svg (the paths, as a sprite).
//
// The marks are Simple Icons 16.35.0 (CC0), read from an unpacked copy of the package so it isn't a dependency:
//   npm pack simple-icons@16.35.0 && tar xzf simple-icons-16.35.0.tgz
//   pnpm --filter @opendash/ui exec tsx scripts/build-brands.ts <folder>/package
// Slack and Amazon Redshift aren't in Simple Icons: theirs are the marks the landing site self-hosts. MySQL's is the
// dolphin alone (sources.tsx). The names and marks are their owners' trademarks, shown only to say which service or
// database a source is.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../../tokens/src/brands.generated.ts");
const marksTarget = path.resolve(here, "../../tokens/src/brand-marks.generated.ts");
const spriteTarget = path.resolve(here, "../../../apps/web/public/brands.svg");
const pkg = process.argv[2];
if (!pkg) throw new Error("Pass the folder of an unpacked simple-icons@16.35.0 (see the top of this file).");
const version = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")).version;
if (version !== "16.35.0") throw new Error(`Expected simple-icons 16.35.0, found ${version}.`);

/**
 * A mark: a Simple Icons slug, a path of our own, or an SVG in ./marks (the landing site's), its paths in one colour
 * (`only`: just the paths filled that colour, the rest being the logo's own tile).
 */
type Entry = {
  title?: string;
  slug?: string;
  path?: string;
  viewBox?: string;
  bg?: string;
  file?: string;
  only?: string;
};

/** An SVG's paths as one, and the box around them (their coordinates are absolute: M, L, C and Z only). */
function fromFile(file: string, only?: string): { path: string; viewBox: string } {
  const svg = readFileSync(path.resolve(here, "marks", file), "utf8");
  const paths = [...svg.matchAll(/<path fill="([^"]+)" d="([^"]+)"/g)]
    .filter(([, fill]) => !only || fill === only)
    .map(([, , d]) => d as string);
  if (!paths.length || paths.some((d) => /[a-z]/.test(d.replace(/[eE]/g, "")) || /[HVSQTA]/.test(d)))
    throw new Error(`${file}: expected absolute M, L, C and Z commands only.`);
  const nums = paths.flatMap((d) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number));
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Square, centred on the mark.
  const side = Math.max(x1 - x0, y1 - y0);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const viewBox = [x0 - (side - (x1 - x0)) / 2, y0 - (side - (y1 - y0)) / 2, side, side].map(round).join(" ");
  return { path: paths.join(""), viewBox };
}

/** Which marks, by our key: a Simple Icons slug, or a mark of our own. `bg` overrides the brand colour. */
const ENTRIES: Record<string, Entry> = {
  // Databases (the source tiles' colours, as the theme has them).
  postgres: { slug: "postgresql", bg: "#336791" },
  mysql: {
    title: "MySQL",
    viewBox: "14.172 3.76 9.828 9.828",
    bg: "#00758f",
    path: readFileSync(path.resolve(here, "../src/icons/sources.tsx"), "utf8").match(
      /export function MySqlLogo[\s\S]*?<path d="([^"]+)"/,
    )?.[1],
  },
  clickhouse: { slug: "clickhouse", bg: "#ffcc01" },
  snowflake: { slug: "snowflake", bg: "#29b5e8" },
  bigquery: { slug: "googlebigquery", bg: "#4285f4" },
  databricks: { slug: "databricks" },
  redshift: { title: "Amazon Redshift", bg: "#4d27a8", file: "redshift.svg", only: "white" },
  duckdb: { slug: "duckdb" },
  trino: { slug: "trino" },
  mongodb: { slug: "mongodb" },
  // Connected services.
  atlassian: { slug: "atlassian" },
  jira: { slug: "jira" },
  confluence: { slug: "confluence" },
  github: { slug: "github" },
  gitlab: { slug: "gitlab" },
  bitbucket: { slug: "bitbucket" },
  linear: { slug: "linear" },
  notion: { slug: "notion" },
  hubspot: { slug: "hubspot" },
  stripe: { slug: "stripe" },
  zendesk: { slug: "zendesk" },
  intercom: { slug: "intercom" },
  sentry: { slug: "sentry" },
  datadog: { slug: "datadog" },
  pagerduty: { slug: "pagerduty" },
  grafana: { slug: "grafana" },
  asana: { slug: "asana" },
  trello: { slug: "trello" },
  clickup: { slug: "clickup" },
  airtable: { slug: "airtable" },
  miro: { slug: "miro" },
  figma: { slug: "figma" },
  box: { slug: "box" },
  dropbox: { slug: "dropbox" },
  google: { slug: "google" },
  googledrive: { slug: "googledrive" },
  googlecalendar: { slug: "googlecalendar" },
  gmail: { slug: "gmail" },
  googleanalytics: { slug: "googleanalytics" },
  cloudflare: { slug: "cloudflare" },
  vercel: { slug: "vercel" },
  netlify: { slug: "netlify" },
  supabase: { slug: "supabase" },
  neon: { slug: "neon" },
  posthog: { slug: "posthog" },
  mixpanel: { slug: "mixpanel" },
  metabase: { slug: "metabase" },
  shopify: { slug: "shopify" },
  paypal: { slug: "paypal" },
  square: { slug: "square" },
  quickbooks: { slug: "quickbooks" },
  xero: { slug: "xero" },
  mailchimp: { slug: "mailchimp" },
  zapier: { slug: "zapier" },
  okta: { slug: "okta" },
  slack: { title: "Slack", bg: "#4a154b", file: "slack.svg" },
};

/**
 * The full-colour logos the landing site shows (copied into apps/web/public/logos): drawn as they are, on a white tile.
 * Every other brand is its mark in its brand colour on the same tile.
 */
const LOGOS: Record<string, string> = {
  postgres: "postgresql.svg",
  mysql: "mysql.svg",
  clickhouse: "clickhouse.png",
  snowflake: "snowflake.png",
  bigquery: "bigquery.png",
  databricks: "databricks.png",
  redshift: "redshift.svg",
  slack: "slack.svg",
  gmail: "gmail.png",
  atlassian: "atlassian.svg",
  hubspot: "hubspot.svg",
};
const logosDir = path.resolve(here, "../../../apps/web/public/logos");
for (const file of Object.values(LOGOS)) readFileSync(path.join(logosDir, file));

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const INK = "#161616";
/** White on the brand colour, or ink where ink reads better (ClickHouse yellow, Supabase green). */
const markOn = (bg: string) =>
  contrast(luminance(bg), 1) >= contrast(luminance(bg), luminance(INK)) ? "#ffffff" : INK;
/** Whether the brand's colour reads as a mark on white; a light one (DuckDB, Mailchimp yellow) keeps its colour as the tile. */
const readsOnWhite = (hex: string) => contrast(luminance(hex), 1) >= 1.9;

const out: Record<
  string,
  { title: string; viewBox: string; path: string; bg: string; fg: string; onWhite: boolean; logo?: string }
> = {};
for (const [key, e] of Object.entries(ENTRIES)) {
  let { title, path: d, viewBox = "0 0 24 24", bg } = e;
  if (e.file) ({ path: d, viewBox } = fromFile(e.file, e.only));
  if (e.slug) {
    const svg = readFileSync(path.join(pkg, "icons", `${e.slug}.svg`), "utf8");
    d = svg.match(/<path d="([^"]+)"/)?.[1];
    title ??= svg.match(/<title>([^<]+)<\/title>/)?.[1];
    const data = JSON.parse(readFileSync(path.join(pkg, "data", "simple-icons.json"), "utf8")) as {
      title: string;
      hex: string;
      slug?: string;
    }[];
    bg ??= `#${data.find((i) => i.slug === e.slug || i.title === title)?.hex ?? ""}`.toLowerCase();
  }
  if (!d || !title || !bg || bg.length !== 7) throw new Error(`No mark, name or colour for ${key}.`);
  const logo = LOGOS[key];
  out[key] = {
    title: title.replace(/&amp;/g, "&"),
    viewBox,
    path: d,
    bg: bg.toLowerCase(),
    fg: markOn(bg),
    onWhite: readsOnWhite(bg),
    ...(logo ? { logo: `/logos/${logo}` } : {}),
  };
}

const HEAD = `Generated by packages/ui/scripts/build-brands.ts from Simple Icons 16.35.0 (CC0) and the landing site's marks.
Don't edit: change the script and run it again. The names and marks are their owners' trademarks, shown only to say
which service or database a source is.`;
const entries = Object.entries(out);

// The names and colours: small, for every page (the Ask panel names services on all of them).
writeFileSync(
  target,
  `${HEAD.replace(/^/gm, "// ")}

export const BRANDS = {
${entries
  .map(([key, b]) => {
    // The tile a web page draws: white for a logo or a colour that reads on white, else the brand's colour.
    const white = Boolean(b.logo) || b.onWhite;
    const tile = white ? "#ffffff" : b.bg;
    const mark = white ? b.bg : b.fg;
    return `  ${JSON.stringify(key)}: { title: ${JSON.stringify(b.title)}, bg: ${JSON.stringify(b.bg)}, fg: ${JSON.stringify(b.fg)}, onWhite: ${b.onWhite}, tile: ${JSON.stringify(tile)}, mark: ${JSON.stringify(mark)}${b.logo ? `, logo: ${JSON.stringify(b.logo)}` : ""} },`;
  })
  .join("\n")}
} as const satisfies Record<
  string,
  { title: string; bg: string; fg: string; onWhite: boolean; tile: string; mark: string; logo?: string }
>;
`,
);
// The marks themselves, for the server: what an App's frame draws comes with its reads (it loads nothing).
writeFileSync(
  marksTarget,
  `${HEAD.replace(/^/gm, "// ")}

import type { BrandKey } from "./brands";

export const BRAND_MARKS: Record<BrandKey, { viewBox: string; path: string }> = {
${entries.map(([key, b]) => `  ${JSON.stringify(key)}: { viewBox: ${JSON.stringify(b.viewBox)}, path: ${JSON.stringify(b.path)} },`).join("\n")}
};
`,
);
// And as one sprite the web app serves and the browser keeps: each mark a <symbol> its tiles <use>.
writeFileSync(
  spriteTarget,
  `<svg xmlns="http://www.w3.org/2000/svg">
<title>Marks of the services and databases OpenDash connects to</title>
<!-- ${HEAD.replace(/\n/g, " ")} -->
${entries.map(([key, b]) => `<symbol id="${key}" viewBox="${b.viewBox}"><path d="${b.path}"/></symbol>`).join("\n")}
</svg>
`,
);
for (const t of [target, marksTarget, spriteTarget]) console.info(`wrote ${path.relative(process.cwd(), t)}`);
console.info(`${entries.length} marks`);
