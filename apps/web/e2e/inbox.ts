/**
 * The local inbox the tests' instance sends to (Mailpit, `pnpm mail:up`), read over its API: the newest email to an
 * address, waited for, and the link its button opens.
 */
const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8027";

interface Summary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

export interface Email {
  subject: string;
  text: string;
  html: string;
}

/** The newest email to `to` whose subject has `subject` in it; waits up to `timeoutMs` for it to arrive. */
export async function emailTo(to: string, subject: string, timeoutMs = 30_000): Promise<Email> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const { messages = [] } = (await res.json()) as { messages?: Summary[] };
    const found = messages.find((m) => m.Subject.includes(subject));
    if (found) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${found.ID}`)).json()) as {
        Subject: string;
        Text: string;
        HTML: string;
      };
      return { subject: full.Subject, text: full.Text, html: full.HTML };
    }
    if (Date.now() > deadline) throw new Error(`No "${subject}" email reached ${to} in ${timeoutMs / 1000}s.`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The link an email's button opens: in the plain text, the line "<label>: <url>". */
export function buttonLink(email: Email, label: string): string {
  const line = email.text.split(/\r?\n/).find((l) => l.startsWith(`${label}: http`));
  if (!line) throw new Error(`The email has no "${label}" link.`);
  return line.slice(label.length + 2).trim();
}
