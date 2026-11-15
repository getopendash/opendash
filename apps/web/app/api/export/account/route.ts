import { accountExport, getAuthDatabase } from "@opendash/auth";
import { exportFolder } from "@opendash/core";
import { currentViewer } from "@/lib/auth";
import { exportDate, exportDownload } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * A person's own data, as a zip (Settings → Your data): their account as OpenDash holds it (never a credential),
 * and in each workspace they're in, what they made and what is about them. Signed in as themselves.
 */
export async function GET() {
  const viewer = await currentViewer().catch(() => null);
  if (!viewer || viewer.kind === "signed-out") return new Response("Sign in first.", { status: 401 });
  const userId = viewer.user.id;
  const account = await accountExport(getAuthDatabase(), userId);
  if (!account) return new Response("Sign in first.", { status: 401 });
  const folders = new Set<string>();
  const parts = account.workspaces.map((w) => {
    // Two workspaces of one name each get a folder of their own.
    let folder = exportFolder(w.name, "workspace");
    for (let n = 2; folders.has(folder); n++) folder = `${exportFolder(w.name, "workspace")}-${n}`;
    folders.add(folder);
    return { kind: "person" as const, orgId: w.id, userId, folder: `workspaces/${folder}` };
  });
  return exportDownload(`opendash-my-data-${exportDate()}.zip`, parts, [{ name: "account.json", json: account }]);
}
