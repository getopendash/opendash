import { getAuth } from "./lib/auth";

/**
 * Production startup check (Node runtime only). Building the auth instance validates the secret, base URL, trusted
 * origins and email settings, so a misconfigured deploy refuses to start instead of failing on the first sign-in.
 * The queue URL is checked here too: without it nothing can be queued (connection tests, later runs).
 */
export async function checkStartup(): Promise<void> {
  try {
    getAuth();
    if (!process.env.DATABASE_QUEUE_URL)
      throw new Error("Set DATABASE_QUEUE_URL (opendash_queue) so work can be queued.");
  } catch (error) {
    // Next logs a failed instrumentation hook but keeps serving 500s; exit so the deploy fails visibly instead.
    console.error(`OpenDash can't start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
