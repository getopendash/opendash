import "server-only";
import { NextResponse } from "next/server";

/** Every answer of a route anyone can reach: never cached, never indexed, and it sends no referrer onward. */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

export const publicJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

/** The JSON body of a public POST, if it's small (a token): anything larger is refused unread. */
export async function smallJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > 1024) return null;
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
