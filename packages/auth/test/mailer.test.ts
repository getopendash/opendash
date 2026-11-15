import type { EmailMessage, EmailSender } from "@opendash/email";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultMailer, emailMailer } from "../src/mailer";

function recordingSender() {
  const sent: { message: EmailMessage; key?: string }[] = [];
  const sender: EmailSender = {
    async send(message, options) {
      sent.push({ message, key: options?.idempotencyKey });
      return { id: `em_${sent.length}` };
    },
  };
  return { sender, sent };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("emailMailer", () => {
  it("sends the rendered template for the kind, tagged, with a key derived from the link", async () => {
    const { sender, sent } = recordingSender();
    const mailer = emailMailer(sender, { host: "app.opendash.test" });
    const url = "https://app.opendash.test/auth/continue?token=one";
    await mailer.send({ to: "maya@acme.com", kind: "sign-up", url });
    await mailer.send({ to: "maya@acme.com", kind: "sign-up", url });
    await mailer.send({ to: "maya@acme.com", kind: "sign-up", url: `${url}-two` });
    expect(sent[0]?.message).toMatchObject({
      to: "maya@acme.com",
      subject: "Confirm your email for OpenDash",
      tags: { kind: "sign-up" },
    });
    expect(sent[0]?.message.text).toContain(url);
    expect(sent[0]?.key).toMatch(/^auth\/[0-9a-f]{40}$/);
    expect(sent[1]?.key).toBe(sent[0]?.key);
    expect(sent[2]?.key).not.toBe(sent[0]?.key);
  });

  it("never sends to reserved test domains", async () => {
    const { sender, sent } = recordingSender();
    await emailMailer(sender, { host: "h" }).send({ to: "maya@acme.test", kind: "sign-in", url: "https://h/x" });
    expect(sent).toHaveLength(0);
  });

  it("passes the organization and inviter through to invitations", async () => {
    const { sender, sent } = recordingSender();
    await emailMailer(sender, { host: "h" }).send({
      to: "gina@acme.com",
      kind: "invitation",
      url: "https://h/invite/1",
      context: { organization: "Acme", inviter: "Alice" },
    });
    expect(sent[0]?.message.subject).toBe("Alice invited you to Acme on OpenDash");
  });
});

describe("defaultMailer", () => {
  it("refuses to run in production without email settings", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SMTP_URL", "");
    vi.stubEnv("EMAIL_FROM", "");
    expect(() => defaultMailer("app.opendash.test")).toThrow(/Set EMAIL_FROM, and RESEND_API_KEY or SMTP_URL/);
  });

  it("uses Resend when both settings are present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "re_test_not_a_real_key");
    vi.stubEnv("EMAIL_FROM", "OpenDash <auth@opendash.test>");
    expect(() => defaultMailer("app.opendash.test")).not.toThrow();
  });
});
