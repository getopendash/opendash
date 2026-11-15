import { BRANDS } from "./brands.generated";

/**
 * Which service or database a source is, for its mark: worked out from where it is (a server's address, a source's
 * dialect), never from its name alone. A name is what an admin typed, and a sign-in card showing a brand's mark for any
 * address would lend that brand's trust to it: the name only tells two marks apart at one address (Jira and Confluence
 * are both atlassian.com). Unknown: null, and the tile shows the name's first letter.
 */
export { BRANDS };
export type BrandKey = keyof typeof BRANDS;
/**
 * A brand as a tile draws it: its colour (`bg`), the colour a mark takes on that colour (`fg`), whether the colour reads
 * as a mark on white (`onWhite`), the tile and mark colours a page draws, and its full-colour logo where the web app
 * has one (`logo`, a path it serves).
 */
export type Brand = {
  key: BrandKey;
  title: string;
  bg: string;
  fg: string;
  onWhite: boolean;
  /** The tile's colour and the mark's on it, as a web page draws them (white for a logo or a colour that reads there). */
  tile: string;
  mark: string;
  logo?: string;
};

const brand = (key: BrandKey): Brand => ({ key, ...BRANDS[key] });

/** By the address's domain (itself or any name under it), and the name only to choose within one. */
const HOSTS: [string, BrandKey | ((name: string) => BrandKey)][] = [
  ["atlassian.com", (n) => (/confluence/i.test(n) ? "confluence" : /jira/i.test(n) ? "jira" : "atlassian")],
  ["atlassian.net", (n) => (/confluence/i.test(n) ? "confluence" : /jira/i.test(n) ? "jira" : "atlassian")],
  ["github.com", "github"],
  ["githubcopilot.com", "github"],
  ["gitlab.com", "gitlab"],
  ["bitbucket.org", "bitbucket"],
  ["linear.app", "linear"],
  ["notion.com", "notion"],
  ["notion.so", "notion"],
  ["hubspot.com", "hubspot"],
  ["stripe.com", "stripe"],
  ["zendesk.com", "zendesk"],
  ["intercom.com", "intercom"],
  ["intercom.io", "intercom"],
  ["sentry.io", "sentry"],
  ["sentry.dev", "sentry"],
  ["datadoghq.com", "datadog"],
  ["datadoghq.eu", "datadog"],
  ["pagerduty.com", "pagerduty"],
  ["grafana.com", "grafana"],
  ["grafana.net", "grafana"],
  ["asana.com", "asana"],
  ["trello.com", "trello"],
  ["clickup.com", "clickup"],
  ["airtable.com", "airtable"],
  ["miro.com", "miro"],
  ["figma.com", "figma"],
  ["box.com", "box"],
  ["dropbox.com", "dropbox"],
  ["dropboxapi.com", "dropbox"],
  [
    "googleapis.com",
    (n) =>
      /bigquery/i.test(n)
        ? "bigquery"
        : /drive|docs|sheets/i.test(n)
          ? "googledrive"
          : /calendar/i.test(n)
            ? "googlecalendar"
            : /gmail|mail/i.test(n)
              ? "gmail"
              : /analytics/i.test(n)
                ? "googleanalytics"
                : "google",
  ],
  ["cloudflare.com", "cloudflare"],
  ["vercel.com", "vercel"],
  ["netlify.com", "netlify"],
  ["supabase.com", "supabase"],
  ["neon.tech", "neon"],
  ["posthog.com", "posthog"],
  ["mixpanel.com", "mixpanel"],
  ["metabase.com", "metabase"],
  ["shopify.com", "shopify"],
  ["paypal.com", "paypal"],
  ["squareup.com", "square"],
  ["intuit.com", "quickbooks"],
  ["xero.com", "xero"],
  ["mailchimp.com", "mailchimp"],
  ["zapier.com", "zapier"],
  ["okta.com", "okta"],
  ["slack.com", "slack"],
  ["mongodb.com", "mongodb"],
  ["databricks.com", "databricks"],
];

/** A connected service's mark, from its address (`mcp.atlassian.com`, `acme.zendesk.com:443`). */
export function brandOfHost(host: string | null | undefined, name = ""): Brand | null {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h) return null;
  for (const [domain, key] of HOSTS) {
    if (h === domain || h.endsWith(`.${domain}`)) return brand(typeof key === "function" ? key(name) : key);
  }
  return null;
}

const DIALECTS: Partial<Record<string, BrandKey>> = {
  postgres: "postgres",
  mysql: "mysql",
  clickhouse: "clickhouse",
  snowflake: "snowflake",
  bigquery: "bigquery",
  databricks: "databricks",
  redshift: "redshift",
  duckdb: "duckdb",
  trino: "trino",
};

/** A database source's mark, from its dialect. MotherDuck, SQL Server and the lake have none: their tile is a letter. */
export function brandOfDialect(dialect: string | null | undefined): Brand | null {
  const key = dialect ? DIALECTS[dialect] : undefined;
  return key ? brand(key) : null;
}
