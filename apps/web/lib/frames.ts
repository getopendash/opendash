import "server-only";
import { dashboards } from "@opendash/core";
import { framesOriginOf } from "./frames-origin";

/** Where dashboards' frames are served from (frames-origin.ts), or null when frames can't open here. */
export function framesOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  return framesOriginOf(env);
}

/** The signed link that opens a frame, or null when frames can't open here. */
export function frameUrl(input: { bundleHash: string | null; title: string }): string | null {
  const origin = framesOrigin();
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!origin || !secret) return null;
  return `${origin}/app-frame/f/${dashboards.signFrameToken(secret, input)}`;
}

/** Whether a request reached this server under the frames origin (frames are served there and nowhere else). */
export function onFramesOrigin(request: Request): boolean {
  const origin = framesOrigin();
  if (!origin) return false;
  const host = request.headers.get("host");
  return !!host && new URL(origin).host === host;
}
