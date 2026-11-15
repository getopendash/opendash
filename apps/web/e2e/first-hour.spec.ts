/**
 * A stranger's first hour, in a real browser against a running instance (`pnpm e2e`): signing up by the emailed
 * link, choosing a password, creating a workspace, connecting a database and asking it something. One person, one
 * page, each step on the one before, so a step that breaks stops the ones after it.
 *
 * The database is the sample company (Acme), seeded beside the instance's own. The question is asked only with a
 * model key (E2E_MODEL=1): it spends, a few cents.
 */
import { expect, type Page, test } from "@playwright/test";
import { buttonLink, emailTo } from "./inbox";
import { open } from "./people";

const stamp = Date.now();
// `.internal` is never delivered on the internet; here it reaches only the local inbox.
const maya = { name: "Maya Chen", email: `maya.${stamp}@acme.internal`, password: `correct horse ${stamp}` };
const workspace = `Acme ${stamp}`;
const demo = JSON.parse(process.env.E2E_DEMO ?? "null") as {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
} | null;

test.describe.configure({ mode: "serial" });

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("signs up with the link in the email, and chooses a password", async () => {
  await open(page, "/sign-up");
  await page.getByLabel("Full name").fill(maya.name);
  await page.getByLabel("Work email").fill(maya.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const email = await emailTo(maya.email, "Confirm your email for OpenDash");
  // Every email says where to ask for help on this instance.
  expect(email.text).toContain("Questions? Write to hello@opendash.internal.");

  await open(page, buttonLink(email, "Confirm email"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(maya.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
});

test("creates a workspace, and is welcomed to the guided setup", async () => {
  await page.getByLabel("Organization name").fill(workspace);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome, Maya\./ })).toBeVisible({ timeout: 60_000 });
  // Skipping it opens OpenDash as it is, in the new workspace.
  await page.getByRole("link", { name: "Skip setup" }).click();
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(workspace);
});

test("connects a database: checked as read-only, then learned", async () => {
  test.skip(!demo, "No sample database (E2E_DEMO): run through pnpm e2e.");
  if (!demo) return;
  await open(page, "/data/sources/new/postgres");
  await page.getByLabel("Host").fill(demo.host);
  await page.getByLabel("Port").fill(demo.port);
  await page.getByLabel("Database").fill(demo.database);
  await page.getByLabel("Username").fill(demo.user);
  await page.getByLabel("Password", { exact: true }).fill(demo.password);
  // The sample sits beside the instance, with no certificate.
  await page.getByRole("button", { name: "SSL mode" }).click();
  await page.getByRole("option", { name: /^disable/ }).click();
  await page.getByRole("button", { name: "Test connection" }).click();

  // The worker runs the check: the user can read, and can't write.
  await expect(page.getByText("Read-only verified")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByRole("heading", { name: demo.database })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Healthy")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Last sync succeeded")).toBeVisible({ timeout: 90_000 });

  // Home now counts the source, and offers the question box.
  await open(page, "/");
  await expect(page.getByRole("textbox", { name: "Your question" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Connect your data" })).toContainText("1 source");
});

test("finds help in the account menu", async () => {
  await page.getByRole("button", { name: "Your account" }).click();
  const support = page.getByRole("menuitem", { name: "Contact support" });
  await expect(support).toBeVisible();
  await expect(support).toHaveAttribute("href", "mailto:hello@opendash.internal");
  await page.keyboard.press("Escape");
});

test("says so when a page isn't there, with the way back", async () => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/isn't here/);
  await page.getByRole("link", { name: /Back to home|Go to OpenDash/ }).click();
  await expect(page.getByRole("textbox", { name: "Your question" })).toBeVisible();
});

test("asks its first question, and gets an answer whose run finished", async () => {
  test.skip(process.env.E2E_MODEL !== "1", "No model key in this run (E2E_MODEL=1 asks the real model: it spends).");
  test.skip(!demo, "No sample database (E2E_DEMO): run through pnpm e2e.");
  test.setTimeout(300_000);
  await open(page, "/");
  await page.getByRole("textbox", { name: "Your question" }).fill("How many accounts do we have?");
  await page.getByRole("button", { name: "Send" }).click();

  // The question opens its own thread, saved before anything runs.
  await expect(page).toHaveURL(/\/ask\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("paragraph").filter({ hasText: "How many accounts do we have?" })).toBeVisible();
  // The run ends as analyzed: not interrupted, not stopped (lib/run-steps.ts names each ending).
  await expect(page.getByRole("button", { name: /^Analyzed for / })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});
