"use server";

import type { SsoNewProvider, SsoProviderChange, SsoResult } from "@opendash/core/enterprise";
import { revalidatePath } from "next/cache";
import { ssoCaller } from "@/lib/sso";

const PAGE = "/settings/single-sign-on";
const missing: SsoResult<never> = {
  ok: false,
  code: "UNAVAILABLE",
  message: "Single sign-on isn't part of this build.",
};

/** Runs one lifecycle step as the signed-in person, then refreshes the page. */
async function step<T>(
  run: (s: NonNullable<Awaited<ReturnType<typeof ssoCaller>>>) => Promise<SsoResult<T>>,
): Promise<SsoResult<T>> {
  const access = await ssoCaller();
  if (!access) return missing;
  const result = await run(access);
  revalidatePath(PAGE);
  return result;
}

export const addProvider = async (input: SsoNewProvider) => step(({ sso, caller }) => sso.create(caller, input));
export const showDnsRecord = async (providerId: string) => step(({ sso, caller }) => sso.dnsRecord(caller, providerId));
export const verifyDomain = async (providerId: string) => step(({ sso, caller }) => sso.verify(caller, providerId));
export const activateProvider = async (providerId: string) =>
  step(({ sso, caller }) => sso.activate(caller, providerId));
export const requireProvider = async (providerId: string, confirmDomain: string) =>
  step(({ sso, caller }) => sso.enforce(caller, providerId, confirmDomain));
export const stopRequiring = async (providerId: string) => step(({ sso, caller }) => sso.unenforce(caller, providerId));
export const disableProvider = async (providerId: string) => step(({ sso, caller }) => sso.disable(caller, providerId));
export const enableProvider = async (providerId: string) => step(({ sso, caller }) => sso.enable(caller, providerId));
export const changeProvider = async (providerId: string, change: SsoProviderChange) =>
  step(({ sso, caller }) => sso.update(caller, providerId, change));
export const replaceSecret = async (providerId: string, clientSecret: string) =>
  step(({ sso, caller }) => sso.rotateSecret(caller, providerId, clientSecret));
export const removeProvider = async (providerId: string) => step(({ sso, caller }) => sso.remove(caller, providerId));
