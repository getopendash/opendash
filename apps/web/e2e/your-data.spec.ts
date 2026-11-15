/**
 * A person's and a workspace's own data, in a real browser (`pnpm e2e`): downloading each as a zip, deleting the
 * workspace, and deleting the account. One person, one page, each step on the one before.
 */
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { createWorkspace, open, signUp, someone } from "./people";

const ines = someone("Ines Okafor");
const stamp = Date.now();
const first = `Lumen ${stamp}`;
const second = `Lumen Two ${stamp}`;

test.describe.configure({ mode: "serial" });

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

/** The names of the files in a zip, read from its directory at the end (no library: the names are stored as text). */
function zipNames(path: string): string[] {
  const bytes = readFileSync(path);
  const names: string[] = [];
  for (
    let at = bytes.indexOf("PK\u0001\u0002", 0, "latin1");
    at !== -1;
    at = bytes.indexOf("PK\u0001\u0002", at + 4, "latin1")
  ) {
    const length = bytes.readUInt16LE(at + 28);
    names.push(bytes.subarray(at + 46, at + 46 + length).toString("utf8"));
  }
  return names;
}

async function download(link: ReturnType<Page["getByRole"]>) {
  const [file] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), files: zipNames(path) };
}

test("an owner downloads the workspace's data as a zip", async () => {
  await signUp(page, ines);
  await createWorkspace(page, first);
  await open(page, "/settings/workspace");
  await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();

  const zip = await download(page.getByRole("link", { name: "Download" }));
  expect(zip.name).toMatch(/^opendash-lumen-\d+-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(zip.files).toEqual(expect.arrayContaining(["members.json", "org.ndjson", "thread.ndjson", "manifest.json"]));
  // Never a table of secrets.
  expect(zip.files.filter((f) => /secret|org_key/.test(f))).toEqual([]);
});

test("anyone downloads their own data as a zip", async () => {
  await open(page, "/settings/account");
  await expect(page.getByRole("heading", { name: "Your data", level: 1 })).toBeVisible();
  const zip = await download(page.getByRole("link", { name: "Download" }));
  expect(zip.name).toMatch(/^opendash-my-data-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(zip.files).toContain("account.json");
  expect(zip.files.some((f) => /^workspaces\/Lumen-\d+\/thread\.ndjson$/.test(f))).toBe(true);
});

test("deleting a workspace asks for its name and the password, and it's gone at once", async () => {
  await open(page, "/settings/workspace");
  await page.getByRole("button", { name: "Delete workspace" }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Delete for good" });
  await expect(confirm).toBeDisabled();

  // The right name with a wrong password deletes nothing, and says which is wrong.
  await dialog.getByLabel("Type the workspace's name to confirm").fill(first);
  await dialog.getByLabel("Your password", { exact: true }).fill("not the password");
  await confirm.click();
  await expect(dialog.getByText("That password isn't right.")).toBeVisible();

  await dialog.getByLabel("Your password", { exact: true }).fill(ines.password);
  await confirm.click();
  // The session's workspace is gone: the app says so, and moves them on to make another.
  await expect(page.getByRole("heading", { name: "You're no longer in that workspace" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: /continue/i }).click();
  await createWorkspace(page, second);
  await open(page, "/");
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(second);
});

test("deleting the account says what goes with it, and then nobody can sign in as them", async () => {
  await open(page, "/settings/account");
  // They're the only one in their workspace: it's deleted with the account, and the page says so first.
  await expect(page.getByText(`${second} has no other member, and is deleted with it.`)).toBeVisible();
  await page.getByRole("button", { name: "Delete account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type your email to confirm").fill(ines.email);
  await dialog.getByLabel("Your password", { exact: true }).fill(ines.password);
  await dialog.getByRole("button", { name: "Delete for good" }).click();
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 60_000 });

  // The app is closed to that browser, and the password signs nobody in.
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/sign-in/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(ines.email);
  await page
    .getByRole("button", { name: /continue|sign in/i })
    .first()
    .click();
  const password = page.getByLabel("Password", { exact: true });
  if (await password.isVisible().catch(() => false)) {
    await password.fill(ines.password);
    await page
      .getByRole("button", { name: /sign in/i })
      .first()
      .click();
  }
  await page.waitForTimeout(2_000);
  await expect(page).toHaveURL(/\/sign-in|check-email/);
});
