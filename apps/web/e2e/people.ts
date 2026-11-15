/**
 * What the end-to-end tests do before their own subject: a new person signing up by the emailed link and choosing a
 * password, and creating a workspace. The same steps first-hour.spec.ts checks one by one.
 */
import { expect, type Page } from "@playwright/test";
import { buttonLink, emailTo } from "./inbox";

export interface Person {
  name: string;
  email: string;
  password: string;
}

let n = 0;
/** A new person: `.internal` is never delivered on the internet; here it reaches only the local inbox. */
export function someone(name: string): Person {
  const stamp = `${Date.now()}${n++}`;
  return {
    name,
    email: `${name.toLowerCase().replace(/\W+/g, ".")}.${stamp}@acme.internal`,
    password: `correct horse ${stamp}`,
  };
}

/** A page is ready to be typed into once its scripts run: before that a form posts as plain HTML and loses the click. */
export async function open(page: Page, path: string) {
  // Tried again if it doesn't settle: a dev server compiling a page for the first time may reload it once.
  await expect(async () => {
    await page.goto(path, { timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
  }).toPass({ timeout: 100_000 });
}

export async function signUp(page: Page, person: Person) {
  await open(page, "/sign-up");
  await page.getByLabel("Full name").fill(person.name);
  await page.getByLabel("Work email").fill(person.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const email = await emailTo(person.email, "Confirm your email for OpenDash");
  await open(page, buttonLink(email, "Confirm email"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
}

export async function createWorkspace(page: Page, name: string) {
  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
  await page.getByLabel("Organization name").fill(name);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "Connect your data" })).toBeVisible();
}
