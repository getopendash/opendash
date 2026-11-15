"use client";

import { useEffect } from "react";

export interface AnalyticsSetup {
  /** PostHog's project key: public by design, it only lets a browser send events. */
  key: string;
  /** Where PostHog's own screens are, for links it makes (its toolbar). */
  uiHost: string;
  userId: string;
  orgId: string;
}

/** A URL without its query or fragment: they can hold a question (`/ask/new?q=`) or a token (`?t=`). */
const bare = (value: string) => value.replace(/[?#].*$/, "");

/** What every event keeps of its properties: URLs cut at their `?` and `#`, no page title, no error message. */
export function scrub(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) properties[key] = bare(value);
  }
  // A page's title can be a dashboard's or a conversation's.
  delete properties.title;
  delete properties.$title;
  const exceptions = properties.$exception_list;
  if (Array.isArray(exceptions)) {
    // Type and frames only, as on the server: a message can quote what was on the page.
    for (const e of exceptions) if (e && typeof e === "object") (e as { value?: string }).value = "";
  }
}

/**
 * Product analytics in the browser, when the deployment has a PostHog key (the layout passes none otherwise, and then
 * nothing loads). Everything goes to this server's /ingest, which relays it (app/ingest). Set up to keep as little as
 * it can and still count: no cookies or storage (in memory, so a new tab is a new visit, and nothing is kept on the
 * person's device; their id still goes to PostHog, which a privacy notice has to say), every text and attribute masked in what a click records, session replay off, and the scrub above on every
 * event. Pages, clicks, rage clicks, web vitals and errors are what it sees.
 */
export function Analytics({ setup }: { setup: AnalyticsSetup }) {
  const { key, uiHost, userId, orgId } = setup;
  useEffect(() => {
    let gone = false;
    void import("posthog-js").then(({ default: posthog }) => {
      if (gone) return;
      if (!posthog.__loaded) {
        posthog.init(key, {
          api_host: "/ingest",
          ui_host: uiHost,
          persistence: "memory",
          person_profiles: "identified_only",
          // The App Router moves between pages without loading them: each move is a page view.
          capture_pageview: "history_change",
          capture_pageleave: "if_capture_pageview",
          autocapture: true,
          mask_all_text: true,
          mask_all_element_attributes: true,
          rageclick: true,
          capture_dead_clicks: false,
          capture_heatmaps: false,
          capture_performance: { web_vitals: true, network_timing: false },
          capture_exceptions: true,
          disable_session_recording: true,
          session_recording: { maskAllInputs: true, maskTextSelector: "*" },
          disable_surveys: true,
          disable_product_tours: true,
          disable_conversations: true,
          disable_web_experiments: true,
          // Nothing is decided by PostHog's settings: what's on is what this file says.
          advanced_disable_flags: true,
          before_send: (event) => {
            if (!event) return event;
            scrub(event.properties);
            scrub(event.$set);
            scrub(event.$set_once);
            return event;
          },
        });
      }
      posthog.identify(userId);
      posthog.group("workspace", orgId);
    });
    return () => {
      gone = true;
    };
  }, [key, uiHost, userId, orgId]);
  return null;
}
