// Trusted origins: exact HTTPS origins only in production.

/** Production auth redirects and CSRF checks accept only exact HTTPS origins. Wildcards and paths are denied. */
export function assertProductionTrustedOrigins(origins: readonly string[]): void {
  if (!origins.length) throw new Error("BETTER_AUTH_TRUSTED_ORIGINS cannot be empty in production");
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must contain valid HTTPS origins");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== origin ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      origin.includes("*")
    ) {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must contain exact HTTPS origins");
    }
  }
}

/**
 * Origins allowed for CSRF-sensitive auth flows. Production must set them explicitly; silently trusting localhost
 * there would weaken CSRF and redirect protection. Passed to Better Auth as a per-request function, so the check
 * fires on a real request rather than at `next build` (Better Auth calls it with no request during init).
 */
export function resolveTrustedOrigins(request?: Request): string[] {
  const raw = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (raw) {
    const origins = [
      ...new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (process.env.NODE_ENV === "production") assertProductionTrustedOrigins(origins);
    return origins;
  }
  if (request && process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must be set in production (comma-separated allowed origins)");
  }
  return ["http://localhost:3000"];
}

export function authBaseUrl(): string {
  if (process.env.NODE_ENV !== "production") return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const value = process.env.BETTER_AUTH_URL?.trim();
  if (!value) throw new Error("BETTER_AUTH_URL is required in production");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin in production");
  }
  return value.replace(/\/$/, "");
}
