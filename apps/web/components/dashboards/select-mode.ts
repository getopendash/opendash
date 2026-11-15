"use client";

import { useSyncExternalStore } from "react";

/**
 * Select to edit: whether pick mode is on, and for which App. The toggle in the App page's top bar and the App's frame
 * on the page are separate parts of it, so they share this: the toggle turns it on and off (Escape too), the frame's
 * host tells its frame and turns it off when the frame says Escape was pressed there.
 */
let state: { dashboardId: string | null } = { dashboardId: null };
const listeners = new Set<() => void>();

export function setPicking(dashboardId: string | null) {
  if (state.dashboardId === dashboardId) return;
  state = { dashboardId };
  for (const fn of listeners) fn();
}

/** Whether pick mode is on for this App. */
export function usePicking(dashboardId: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state.dashboardId === dashboardId,
    () => false,
  );
}
