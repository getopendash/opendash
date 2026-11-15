// A server action called from the browser: its answer, or, when the call itself throws (a deploy, the network, a
// server error), a failure in words, so nothing that waits on it is left spinning.

export const UNREACHABLE = "OpenDash couldn't be reached. Try again in a moment.";

export async function answerOf<T extends { ok: boolean }>(
  call: () => Promise<T>,
): Promise<T | { ok: false; message: string }> {
  try {
    return await call();
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}
