"use server";

import type { ScimRole, SsoResult } from "@opendash/core/enterprise";
import { revalidatePath } from "next/cache";
import { enterprise } from "@/enterprise";
import { ssoCaller } from "@/lib/sso";

const PAGE = "/settings/directory-sync";
const missing: SsoResult<never> = {
  ok: false,
  code: "UNAVAILABLE",
  message: "Directory sync isn't part of this build.",
};

/** One directory-sync step as the signed-in person, then the page again. */
async function step<T>(
  run: (
    scim: NonNullable<ReturnType<typeof enterprise>["scim"]>,
    caller: NonNullable<Awaited<ReturnType<typeof ssoCaller>>>["caller"],
  ) => Promise<SsoResult<T>>,
): Promise<SsoResult<T>> {
  const scim = enterprise().scim;
  const access = await ssoCaller();
  if (!scim || !access) return missing;
  const result = await run(scim, access.caller);
  revalidatePath(PAGE);
  return result;
}

export const connectDirectory = async () => step((scim, caller) => scim.connect(caller));
export const newDirectoryToken = async () => step((scim, caller) => scim.rotate(caller));
export const disconnectDirectory = async () => step((scim, caller) => scim.disconnect(caller));
export const mapDirectoryGroup = async (groupId: string, role: ScimRole | null) =>
  step((scim, caller) => scim.mapGroup(caller, groupId, role));
