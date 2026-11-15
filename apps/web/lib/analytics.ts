import "server-only";
import { analyticsConfig } from "@opendash/core";
import type { AnalyticsSetup } from "@/components/shell/analytics";

/**
 * What the browser needs for product analytics, read from this server's environment on each request (never built
 * into the image, which self-hosted installs share): null without POSTHOG_KEY, and then the browser loads nothing.
 */
export function analyticsSetup(userId: string, orgId: string): AnalyticsSetup | null {
  const config = analyticsConfig();
  if (!config) return null;
  // PostHog Cloud's screens are on its app host (eu.posthog.com); a PostHog of your own serves both from one.
  const uiHost = config.host.replace(/^https:\/\/(eu|us)\.i\.posthog\.com$/, "https://$1.posthog.com");
  return { key: config.key, uiHost, userId, orgId };
}
