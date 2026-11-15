/**
 * The guided setup (/get-started), in a real browser (`pnpm e2e`): the welcome, connecting a database of one's own
 * through it, the model step where the server has no key, and the last step saying what's missing. Every step can
 * be skipped, and what's done stays done.
 *
 * The sample data in one press reaches ClickHouse's public playground over the internet, so it runs only when asked
 * (E2E_PLAYGROUND=1): a third party's uptime shouldn't fail a build.
 */
import { expect, type Page, test } from "@playwright/test";
import { createWorkspace, open, signUp, someone } from "./people";

const demo = JSON.parse(process.env.E2E_DEMO ?? "null") as {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
} | null;
const hasModel = process.env.E2E_MODEL === "1";

test.describe.configure({ mode: "serial" });

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("welcomes a new workspace: what OpenDash does, and the two things a first answer needs", async () => {
  await signUp(page, someone("Dana Whitfield"));
  await createWorkspace(page, `Northwind ${Date.now()}`);
  await expect(page).toHaveURL(/\/get-started$/);
  await expect(page.getByRole("heading", { name: /^Welcome, Dana\./ })).toBeVisible();
  for (const title of ["Ask in plain language", "Turn answers into dashboards", "Let routines watch for you"]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await expect(page.getByText("Your data", { exact: true })).toBeVisible();
  await expect(page.getByText("A model", { exact: true })).toBeVisible();
  // It fits the window: nothing to scroll, on a laptop's screen or a shorter one.
  for (const height of [720, 600]) {
    await page.setViewportSize({ width: 1280, height });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight))
      .toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Where's your data?" })).toBeVisible();
  // Both ways in: the sample data, and a database of one's own.
  await expect(page.getByRole("button", { name: "Use sample data" })).toBeVisible();
  await expect(page.getByRole("link", { name: "PostgreSQL" })).toBeVisible();
});

test("connects a database of one's own without leaving the setup, and goes on while it's learned", async () => {
  test.skip(!demo, "No sample database (E2E_DEMO): run through pnpm e2e.");
  if (!demo) return;
  await page.getByRole("link", { name: "PostgreSQL" }).click();
  await expect(page.getByRole("heading", { name: "Connect PostgreSQL" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Host").fill(demo.host);
  await page.getByLabel("Port").fill(demo.port);
  await page.getByLabel("Database").fill(demo.database);
  await page.getByLabel("Username").fill(demo.user);
  await page.getByLabel("Password", { exact: true }).fill(demo.password);
  await page.getByRole("button", { name: "SSL mode" }).click();
  await page.getByRole("option", { name: /^disable/ }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Read-only verified")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  // On to the model, not out to the app.
  await expect(page).toHaveURL(/\/get-started\/ai$/, { timeout: 60_000 });
  // The Data step is ticked in the bar, and says so when opened again.
  await expect(page.getByRole("navigation", { name: "Setup steps" }).getByLabel("Done")).toHaveCount(1);
});

test("the model step: nothing to do where a model runs, a provider's key where none does", async () => {
  await open(page, "/get-started/ai");
  if (hasModel) {
    await expect(page.getByRole("heading", { name: "A model is ready" })).toBeVisible();
    await page.getByRole("link", { name: "Continue" }).click();
  } else {
    await expect(page.getByRole("heading", { name: "Bring a model" })).toBeVisible();
    // The same dialog as Settings → AI opens for a provider, and closes without saving.
    await page.getByRole("button", { name: /Anthropic/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("link", { name: "Skip for now" }).click();
  }
  await expect(page).toHaveURL(/\/get-started\/ask$/);
});

test("the last step offers first questions, says what's missing, and opens OpenDash either way", async () => {
  await expect(page.getByRole("heading", { name: "Ask your first question" })).toBeVisible();
  await expect(page.getByRole("button", { name: /What can I ask about this data/ })).toBeVisible();
  if (!hasModel) {
    await expect(page.getByText("There's no model to answer yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: /What can I ask about this data/ })).toBeDisabled();
    await page.getByRole("link", { name: "Open OpenDash" }).click();
  } else {
    await page.getByRole("link", { name: "I'll explore on my own" }).click();
  }
  await expect(page).toHaveURL(/localhost:\d+\/$/);
  // Home still offers the way back in until setup is finished.
  await expect(page.getByRole("link", { name: "Open the guided setup" })).toBeVisible();
});

test("the sample data connects in one press, with its tables chosen for the person", async () => {
  test.skip(process.env.E2E_PLAYGROUND !== "1", "Reaches ClickHouse's public playground: E2E_PLAYGROUND=1 runs it.");
  const fresh = await page.context().browser()?.newPage();
  if (!fresh) return;
  try {
    await signUp(fresh, someone("Priya Raman"));
    await createWorkspace(fresh, `Globex ${Date.now()}`);
    await fresh.getByRole("link", { name: "Get started" }).click();
    await fresh.getByRole("button", { name: "Use sample data" }).click();
    await expect(fresh.getByRole("heading", { name: "Connecting the sample data" })).toBeVisible();
    await expect(fresh).toHaveURL(/\/get-started\/ai$/, { timeout: 120_000 });
    await open(fresh, "/get-started/ask");
    // Learned without a table picked by hand, and the questions are about its own tables.
    await expect(fresh.getByText(/ClickHouse playground is learned|no model to answer/).first()).toBeVisible({
      timeout: 240_000,
    });
    await expect(fresh.getByRole("button", { name: /house price in the UK/ })).toBeVisible();
    await open(fresh, "/data/sources");
    await expect(fresh.getByText("ClickHouse playground").first()).toBeVisible();
  } finally {
    await fresh.close();
  }
});
