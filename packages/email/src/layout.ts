/**
 * One email-safe layout for every OpenDash email: nested tables, inline styles (email clients ignore stylesheets),
 * colours from the design tokens (the same values as the light theme), and a plain-text twin.
 * Every value interpolated into HTML is escaped here; callers pass plain strings.
 */
import { tokens } from "@opendash/tokens";

const c = tokens.light;
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface EmailContent {
  subject: string;
  /** Inbox preview line. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Titled lists of linked items (a digest's insights and tasks), after the paragraphs. */
  sections?: { title: string; items: { title: string; detail?: string; url: string }[] }[];
  button: { label: string; url: string };
  note: string;
  footer: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only web links go in emails; anything else (javascript:, data:) is a bug upstream. */
export function assertWebUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Email links must be http(s)");
  return parsed.toString();
}

/** Subjects come partly from names people type (organizations, inviters). Keep them to one tidy line. */
export function oneLine(value: string, max = 120): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const text = (size: number, lineHeight: number, weight: number, color: string) =>
  `font-family:${FONT};font-size:${size}px;line-height:${lineHeight}px;font-weight:${weight};color:${color};`;

/** The logo at the top of every email: drawn by scripts/email-logo.mjs, served from the web app's public folder. */
export const EMAIL_LOGO_PATH = "/email/opendash-logo@2x.png";

const ADDRESS = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/**
 * The address people write to for help on this instance (OPENDASH_SUPPORT_EMAIL, set on the web app and the worker,
 * which both send email), or null when its operator set none or it isn't an address. Every email's footer names it.
 */
export function supportAddress(env: Record<string, string | undefined> = process.env): string | null {
  const given = env.OPENDASH_SUPPORT_EMAIL?.trim();
  return given && ADDRESS.test(given) ? given : null;
}

export function renderEmail(
  content: EmailContent,
  env: Record<string, string | undefined> = process.env,
): RenderedEmail {
  const url = assertWebUrl(content.button.url);
  const e = escapeHtml;
  const support = supportAddress(env);
  const help = support
    ? `<tr><td style="padding:8px 4px 0;${text(12, 18, 400, c["muted-tertiary"])}">Questions? Write to <a href="mailto:${e(support)}" style="color:${c.link};">${e(support)}</a>.</td></tr>\n`
    : "";
  const href = e(url);
  // Every email's button opens this instance, so its origin is also where the logo is served and where it links.
  const home = new URL(url).origin;
  const paragraphs = content.paragraphs
    .map((p) => `<p style="margin:0 0 16px;${text(14, 22, 400, c.foreground)}">${e(p)}</p>`)
    .join("");
  const sections = (content.sections ?? [])
    .map(
      (s) =>
        `<p style="margin:8px 0 4px;${text(12, 18, 600, c["muted-tertiary"])}">${e(s.title)}</p>` +
        s.items
          .map(
            (item) =>
              `<p style="margin:0;padding:10px 0;border-bottom:1px solid ${c.border};">` +
              `<a href="${e(assertWebUrl(item.url))}" style="text-decoration:none;${text(14, 20, 500, c.link)}">${e(item.title)}</a>` +
              (item.detail ? `<br><span style="${text(12, 18, 400, c.muted)}">${e(item.detail)}</span>` : "") +
              "</p>",
          )
          .join(""),
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${e(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${c.background};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${c.background};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="padding:0 4px 20px;">
<a href="${e(home)}" style="text-decoration:none;"><img src="${e(home + EMAIL_LOGO_PATH)}" width="121" height="22" alt="OpenDash" style="display:block;width:121px;height:22px;border:0;outline:none;text-decoration:none;${text(15, 22, 600, c.foreground)}"></a>
</td></tr>
<tr><td style="background-color:${c.surface};border:1px solid ${c.border};border-radius:12px;padding:32px;">
<h1 style="margin:0 0 12px;${text(20, 28, 600, c.foreground)}">${e(content.heading)}</h1>
${paragraphs}
${sections}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>
<td style="border-radius:6px;background-color:${c.accent};">
<a href="${href}" style="display:inline-block;padding:10px 18px;border-radius:6px;text-decoration:none;${text(14, 20, 600, c["accent-foreground"])}">${e(content.button.label)}</a>
</td></tr></table>
<p style="margin:0 0 12px;${text(12, 18, 400, c.muted)}">${e(content.note)}</p>
<p style="margin:0;${text(12, 18, 400, c.muted)}">If the button doesn't work, paste this link into your browser:<br><a href="${href}" style="color:${c.link};word-break:break-all;">${e(url)}</a></p>
</td></tr>
<tr><td style="padding:20px 4px 0;${text(12, 18, 400, c["muted-tertiary"])}">${e(content.footer)}</td></tr>
${help}</table>
</td></tr>
</table>
</body>
</html>`;

  const plain = [
    content.heading,
    "",
    ...content.paragraphs.flatMap((p) => [p, ""]),
    ...(content.sections ?? []).flatMap((s) => [
      s.title,
      ...s.items.flatMap((item) => [`- ${item.title}`, ...(item.detail ? [`  ${item.detail}`] : []), `  ${item.url}`]),
      "",
    ]),
    `${content.button.label}: ${url}`,
    "",
    content.note,
    "",
    "--",
    content.footer,
    ...(support ? [`Questions? Write to ${support}.`] : []),
  ].join("\n");

  return { subject: oneLine(content.subject), html, text: plain };
}
