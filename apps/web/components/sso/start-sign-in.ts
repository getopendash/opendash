/**
 * Starts single sign-on from the browser: the auth server answers with the identity provider's address, and the
 * browser goes there. A test sign-in from Settings comes back to Settings, where its session proves the provider works.
 */
export async function startSsoSignIn(options: {
  providerId?: string;
  email?: string;
  /** Where to land afterwards (sign-in page: the page they were going to). */
  next?: string;
  test?: boolean;
}): Promise<{ message: string } | undefined> {
  const back = options.test ? `/settings/single-sign-on?tested=${encodeURIComponent(options.providerId ?? "")}` : null;
  const response = await fetch("/api/auth/sign-in/sso", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      ...(options.providerId ? { providerId: options.providerId } : { email: options.email }),
      callbackURL: back ?? options.next ?? "/",
      errorCallbackURL: back
        ? `/settings/single-sign-on?test_failed=${encodeURIComponent(options.providerId ?? "")}`
        : "/sign-in?sso=failed",
    }),
  }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as { url?: unknown; message?: unknown } | null;
  if (!response?.ok || typeof body?.url !== "string") {
    return {
      message:
        typeof body?.message === "string" ? body.message : "Single sign-on couldn't start. Try again in a moment.",
    };
  }
  window.location.assign(body.url);
  return undefined;
}
