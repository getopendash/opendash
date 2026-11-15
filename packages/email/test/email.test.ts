import { describe, expect, it, vi } from "vitest";
import { authEmail } from "../src/auth-emails";
import { digestEmail } from "../src/digest-email";
import { EMAIL_LOGO_PATH, renderEmail, supportAddress } from "../src/layout";
import { EmailError, emailLinkOrigin, isUndeliverable, resendOutcome, resendSender, within } from "../src/resend";
import { routineEmail, routineFooter } from "../src/routine-email";
import { emailSenderFromEnv } from "../src/sender";
import { type SmtpTransport, smtpOutcome, smtpSender, smtpTransport } from "../src/smtp";

const url = "https://app.opendash.test/auth/continue?token=abc&callbackURL=%2F";
const base = { to: "maya@acme.test", url, host: "app.opendash.test" };

/** Every email opens with the logo, served by the instance its button opens and linking there; "OpenDash" as text if
 * images are blocked. The plain-text twin has no image. */
function expectLogo(email: { html: string; text: string }, origin = "https://app.opendash.test") {
  expect(email.html).toContain(
    `<a href="${origin}" style="text-decoration:none;"><img src="${origin}${EMAIL_LOGO_PATH}" width="121" height="22" alt="OpenDash"`,
  );
  expect(email.text).not.toContain(EMAIL_LOGO_PATH);
}

describe("auth emails", () => {
  it.each([
    ["sign-up", "Confirm your email for OpenDash", "Confirm email"],
    ["sign-in", "Sign in to OpenDash", "Sign in"],
    ["reset-password", "Reset your OpenDash password", "Choose a new password"],
  ] as const)("%s has its subject, button and link in both versions", (kind, subject, label) => {
    const email = authEmail(kind, base);
    expect(email.subject).toBe(subject);
    expect(email.html).toContain(`>${label}</a>`);
    expect(email.html).toContain('href="https://app.opendash.test/auth/continue?token=abc&amp;callbackURL=%2F"');
    expect(email.text).toContain(`${label}: ${url}`);
    expect(email.text).toContain("maya@acme.test");
    expect(email.html).toContain("app.opendash.test");
    expectLogo(email);
  });

  it("invitations name the organization and inviter, escaped, on one line", () => {
    const email = authEmail("invitation", {
      ...base,
      organization: 'Acme <script>alert("x")</script>',
      inviter: "Priya\r\nBcc: someone@evil.test",
    });
    expect(email.subject).toBe(
      'Priya Bcc: someone@evil.test invited you to Acme <script>alert("x")</script> on OpenDash',
    );
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("Acme &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.text).toContain("expires in 7 days");
    expectLogo(email);
  });

  it("refuses links that aren't web links", () => {
    expect(() => authEmail("sign-in", { ...base, url: "javascript:alert(1)" })).toThrow(/http/);
  });
});

describe("Resend sender", () => {
  it("sends from the configured address with tags and an idempotency key", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "em_123" }, error: null });
    const sender = resendSender({ from: "OpenDash <auth@opendash.test>", client: { emails: { send } } });
    const email = authEmail("sign-up", base);
    await expect(
      sender.send({ to: base.to, ...email, tags: { kind: "sign-up" } }, { idempotencyKey: "k1" }),
    ).resolves.toEqual({
      id: "em_123",
    });
    expect(send).toHaveBeenCalledWith(
      {
        from: "OpenDash <auth@opendash.test>",
        to: "maya@acme.test",
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: [{ name: "kind", value: "sign-up" }],
      },
      { idempotencyKey: "k1" },
    );
  });

  it("passes its signal on, and gives up with a timeout EmailError once the signal ends", async () => {
    const send = vi.fn().mockReturnValue(new Promise(() => {}));
    const sender = resendSender({ from: "x@y.test", client: { emails: { send } } });
    const stop = new AbortController();
    const failure = sender.send({ to: "a@b.test", subject: "s", html: "h", text: "h" }, { signal: stop.signal });
    expect(send.mock.calls[0]?.[1]).toEqual({ signal: stop.signal });
    stop.abort();
    // It may still go: unclear, so the outbox doesn't send it again.
    await expect(failure).rejects.toMatchObject({ name: "EmailError", code: "timeout", outcome: "unclear" });
  });

  it("observes a send it stopped waiting for before it began, so its late failure is never unhandled", async () => {
    const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("refused")), 5));
    await expect(within(late, AbortSignal.abort())).rejects.toMatchObject({ code: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("reads Resend's answer for whether the email may have gone", () => {
    expect(resendOutcome({ name: "validation_error", statusCode: 422 })).toBe("rejected");
    expect(resendOutcome({ name: "invalid_api_Key", statusCode: 403 })).toBe("rejected");
    expect(resendOutcome({ name: "rate_limit_exceeded", statusCode: 429 })).toBe("not_sent");
    // The key's answers mean an earlier request with it was taken, or still is.
    expect(resendOutcome({ name: "invalid_idempotent_request", statusCode: 409 })).toBe("unclear");
    expect(resendOutcome({ name: "concurrent_idempotent_requests", statusCode: 409 })).toBe("unclear");
    expect(resendOutcome({ name: "internal_server_error", statusCode: 500 })).toBe("unclear");
    // The request failed or was cut off: no status.
    expect(resendOutcome({ name: "application_error", statusCode: null })).toBe("unclear");
  });

  it("turns a Resend error into an EmailError", async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: { name: "validation_error", statusCode: 403, message: "The domain is not verified" },
    });
    const sender = resendSender({ from: "x@y.test", client: { emails: { send } } });
    const failure = sender.send({ to: "a@b.test", subject: "s", html: "<p>h</p>", text: "h" });
    await expect(failure).rejects.toBeInstanceOf(EmailError);
    await expect(failure).rejects.toMatchObject({ code: "validation_error", status: 403, outcome: "rejected" });
  });

  it("is configured by EMAIL_FROM with RESEND_API_KEY or SMTP_URL, and by neither alone", () => {
    expect(emailSenderFromEnv({})).toBeNull();
    expect(emailSenderFromEnv({ RESEND_API_KEY: "re_x" })).toBeNull();
    expect(emailSenderFromEnv({ SMTP_URL: "smtp://u:p@mail.example.net:587" })).toBeNull();
    expect(emailSenderFromEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.test" })).not.toBeNull();
    expect(emailSenderFromEnv({ SMTP_URL: "smtp://u:p@mail.example.net:587", EMAIL_FROM: "a@b.test" })).not.toBeNull();
  });
});

describe("smtpSender", () => {
  const capture = () => {
    const sent: Parameters<SmtpTransport["sendMail"]>[0][] = [];
    const transport: SmtpTransport = {
      sendMail: async (mail) => {
        sent.push(mail);
        return { messageId: mail.messageId ?? "<generated@mail>" };
      },
    };
    return { sent, transport };
  };

  it("sends the message from EMAIL_FROM, its headers kept, the idempotency key as its Message-ID", async () => {
    const { sent, transport } = capture();
    const sender = smtpSender({ from: "OpenDash <auth@opendash.example>", transport });
    const result = await sender.send(
      {
        to: "maya@acme.com",
        subject: "Sign in",
        html: "<p>h</p>",
        text: "h",
        tags: { kind: "sign-in" },
        headers: { "List-Unsubscribe": "<https://app.opendash.example/u>" },
      },
      { idempotencyKey: "auth/abc123" },
    );
    expect(sent).toEqual([
      {
        from: "OpenDash <auth@opendash.example>",
        to: "maya@acme.com",
        subject: "Sign in",
        html: "<p>h</p>",
        text: "h",
        headers: { "List-Unsubscribe": "<https://app.opendash.example/u>" },
        messageId: "<auth-abc123@opendash.example>",
      },
    ]);
    expect(result).toEqual({ id: "<auth-abc123@opendash.example>" });
  });

  it("gives up with a timeout EmailError once its signal ends", async () => {
    const transport: SmtpTransport = { sendMail: () => new Promise(() => {}) };
    const failure = smtpSender({ from: "a@opendash.example", transport }).send(
      { to: "x@acme.com", subject: "s", html: "h", text: "h" },
      { signal: AbortSignal.timeout(10) },
    );
    await expect(failure).rejects.toMatchObject({ name: "EmailError", code: "timeout", outcome: "unclear" });
  });

  it("reads an SMTP failure for whether the email may have gone", () => {
    expect(smtpOutcome({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 })).toBe("rejected");
    expect(smtpOutcome({ code: "EMESSAGE", command: "DATA", responseCode: 451 })).toBe("not_sent");
    // Connecting, greeting, TLS or signing in: nothing was given to the server yet.
    expect(smtpOutcome({ code: "ECONNECTION", command: "CONN" })).toBe("not_sent");
    expect(smtpOutcome({ code: "ETIMEDOUT", command: "CONN" })).toBe("not_sent");
    expect(smtpOutcome({ code: "EAUTH", command: "AUTH PLAIN", responseCode: undefined })).toBe("not_sent");
    // Cut off mid-send: it may have been delivered.
    expect(smtpOutcome({ code: "ETIMEDOUT", command: "DATA" })).toBe("unclear");
    expect(smtpOutcome({ code: "ESOCKET" })).toBe("unclear");
  });

  it("turns a refusal into an EmailError with the SMTP code", async () => {
    const transport: SmtpTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("Mailbox unavailable"), { code: "EENVELOPE", responseCode: 550 });
      },
    };
    const failure = smtpSender({ from: "a@opendash.example", transport }).send({
      to: "x@acme.com",
      subject: "s",
      html: "h",
      text: "h",
    });
    await expect(failure).rejects.toBeInstanceOf(EmailError);
    await expect(failure).rejects.toMatchObject({ code: "EENVELOPE", status: 550, outcome: "rejected" });
  });

  it("requires TLS unless the URL says otherwise, and gives the server the caller's timeouts", () => {
    const options = (url: string, timeouts?: { connectMs: number; socketMs: number }) =>
      (smtpTransport(url, timeouts) as unknown as { transporter: { options: Record<string, unknown> } }).transporter
        .options;
    expect(options("smtp://u:p@mail.example.net:587", { connectMs: 5_000, socketMs: 10_000 })).toMatchObject({
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
    expect(options("smtp://u:p@mail.example.net:587")).toMatchObject({ requireTLS: true, secure: false });
    expect(options("smtps://u:p@mail.example.net:465")).toMatchObject({ secure: true });
    expect(options("smtp://mailpit:1025?requireTLS=false")).toMatchObject({ requireTLS: false });
  });
});

describe("isUndeliverable", () => {
  it("flags reserved test domains and nothing else", () => {
    for (const a of [
      "maya@acme.test",
      "a@example.com",
      "a@mail.example.org",
      "a@x.invalid",
      "a@host.localhost",
      "a@x.example",
    ]) {
      expect(isUndeliverable(a)).toBe(true);
    }
    for (const a of ["maya@acme.com", "delivered@resend.dev", "a@examples.com", "a@notexample.com"]) {
      expect(isUndeliverable(a)).toBe(false);
    }
  });
});

const footer = {
  because: "Every Monday at 07:00, send what OpenDash found to me.",
  routineUrl: "https://app.opendash.test/routines/01a12738-6aa2-772d-afdb-5392fed386e3",
};

describe("a routine's footer", () => {
  it("says which routine sent it, where to change it, and how to leave it in one click", () => {
    expect(routineFooter(footer)).toBe(
      "You get this from a routine: Every Monday at 07:00, send what OpenDash found to me. Change it: https://app.opendash.test/routines/01a12738-6aa2-772d-afdb-5392fed386e3",
    );
    expect(routineFooter({ ...footer, unsubscribeUrl: "https://app.opendash.test/unsubscribe?t=abc" })).toMatch(
      / · Unsubscribe: https:\/\/app\.opendash\.test\/unsubscribe\?t=abc$/,
    );
  });
});

describe("what OpenDash found", () => {
  const data = {
    organization: "Check <Co>",
    baseUrl: "https://app.opendash.test/",
    counts: { insights: 2, goalsAtRisk: 1, tasks: 1 },
    insights: [
      {
        title: "Monthly recurring revenue is on course to miss its goal for Dec 31, 2026",
        detail: "$412.6k in September",
      },
      { title: "New accounts fell more than usual in September 2026", detail: "77 · expected 84–94" },
    ],
    tasks: [{ title: "Find why <September> sign-ups dropped", detail: "In progress" }],
  };

  it("lists what's open and the person's tasks, each linking into the app, escaped", () => {
    const email = routineEmail({ ...footer, kind: "digest", digest: data });
    expect(email.subject).toBe("What's open at Check <Co>: 2 insights");
    expect(email.html).toContain("2 insights are open, 1 goal is at risk, and you have 1 open task.");
    expect(email.html).toContain('href="https://app.opendash.test/insights"');
    expect(email.html).toContain('href="https://app.opendash.test/tasks"');
    expect(email.html).toContain("Find why &lt;September&gt; sign-ups dropped");
    expect(email.html).not.toContain("<September>");
    expect(email.html).toContain("Check &lt;Co&gt;");
    expect(email.text).toContain(
      "- New accounts fell more than usual in September 2026\n  77 · expected 84–94\n  https://app.opendash.test/insights",
    );
    expect(email.text).toContain("You get this from a routine: Every Monday at 07:00, send what OpenDash found to me.");
    expectLogo(email);
  });

  it("drops a section with nothing in it, and refuses a link that isn't the web", () => {
    const quiet = digestEmail({ ...data, counts: { insights: 0, goalsAtRisk: 0, tasks: 1 }, insights: [] }, "f");
    expect(quiet.html).not.toContain(">Insights</p>");
    expect(quiet.html).toContain("0 insights are open, and you have 1 open task.");
    expect(() => digestEmail({ ...data, baseUrl: "javascript:alert(1)//" }, "f")).toThrow();
  });
});

describe("a routine's other emails", () => {
  it("tells a finding at once, or the day's roundup, each linking to Insights", () => {
    const one = routineEmail({
      ...footer,
      kind: "findings",
      findings: {
        organization: "Check Co",
        baseUrl: "https://app.opendash.test",
        roundup: false,
        findings: [
          {
            id: "01a12be7-c4f1-7072-8192-b3e697ef7882",
            title: "New accounts fell more than usual in September 2026",
            detail: "77 · usually 85–93",
            verdict: "Its investigation confirmed it.",
          },
        ],
      },
    });
    expect(one.subject).toBe("New accounts fell more than usual in September 2026");
    expect(one.text).toContain("77 · usually 85–93 · Its investigation confirmed it.");
    const day = routineEmail({
      ...footer,
      kind: "findings",
      findings: { organization: "Check Co", baseUrl: "https://app.opendash.test", roundup: true, findings: [] },
    });
    expect(day.subject).toBe("0 findings at Check Co today");
    for (const email of [one, day]) expectLogo(email);
  });

  it("answers a question on a schedule, and tells an owner their routine paused", () => {
    const answer = routineEmail({
      ...footer,
      kind: "answer",
      answer: {
        organization: "Check Co",
        baseUrl: "https://app.opendash.test",
        threadId: "01a12be7-c4f1-7072-8192-b3e697ef7883",
        runId: "01a12be7-c4f1-7072-8192-b3e697ef7884",
        question: "How many accounts signed up last week?",
        sourceName: "opendash_demo",
        answeredAt: "2026-10-12T05:02:00Z",
        answer: "212 accounts signed up last week.",
        verified: true,
      },
    });
    expect(answer.subject).toBe("How many accounts signed up last week?");
    expect(answer.text).toContain("212 accounts signed up last week.");
    expect(answer.html).toContain('href="https://app.opendash.test/ask/01a12be7-c4f1-7072-8192-b3e697ef7883"');
    const paused = routineEmail({
      ...footer,
      kind: "paused",
      paused: { organization: "Check Co", baseUrl: "https://app.opendash.test", reason: "It failed 4 times in a row." },
    });
    expect(paused.subject).toBe("A routine of yours paused at Check Co");
    expect(paused.text).toContain("You get this because you own the routine.");
    expect(paused.html).toContain('href="https://app.opendash.test/routines/01a12738-6aa2-772d-afdb-5392fed386e3"');
    for (const email of [answer, paused]) expectLogo(email);
  });
});

describe("emailLinkOrigin", () => {
  it("is the web app's HTTPS origin in production, and nothing when it isn't one", () => {
    expect(emailLinkOrigin({ NODE_ENV: "production", BETTER_AUTH_URL: "https://app.opendash.example" })).toBe(
      "https://app.opendash.example",
    );
    expect(emailLinkOrigin({ NODE_ENV: "production" })).toBeNull();
    expect(emailLinkOrigin({ NODE_ENV: "production", BETTER_AUTH_URL: "http://app.opendash.example" })).toBeNull();
    expect(emailLinkOrigin({ NODE_ENV: "production", BETTER_AUTH_URL: "https://app.opendash.example/x" })).toBeNull();
    expect(emailLinkOrigin({ NODE_ENV: "development" })).toBe("http://localhost:3000");
  });
});

describe("the support address", () => {
  const content = {
    subject: "Sign in to OpenDash",
    preheader: "Your sign-in link",
    heading: "Sign in",
    paragraphs: ["Open the link to sign in."],
    button: { label: "Sign in", url },
    note: "The link works once.",
    footer: "You're getting this because this address was used on OpenDash.",
  };

  it("closes every email, as a link and in the plain text, when the instance has one", () => {
    const email = renderEmail(content, { OPENDASH_SUPPORT_EMAIL: " hello@opendash.test " });
    expect(email.html).toContain('Questions? Write to <a href="mailto:hello@opendash.test"');
    expect(email.text.endsWith("Questions? Write to hello@opendash.test.")).toBe(true);
  });

  it("is left out when none is set, or what's set isn't an address", () => {
    for (const given of [undefined, "", "not an address", 'x"><script>@opendash.test', "a@b"]) {
      const email = renderEmail(content, { OPENDASH_SUPPORT_EMAIL: given });
      expect(email.html).not.toContain("Questions?");
      expect(email.text).not.toContain("Questions?");
      expect(supportAddress({ OPENDASH_SUPPORT_EMAIL: given })).toBeNull();
    }
  });
});
