import { useSyncExternalStore } from "react";

/**
 * Whether the App a page shows has drawn and its answers are in, by revision: what the render check waits for before
 * it draws its hidden copies. They used to start with the page, so the owner of a fresh draft loaded four frames at
 * once (four runtime downloads within a fraction of a second, eight times in one morning), and the
 * App they were waiting to see competed with three they never see.
 */
const settled = new Set<string>();
const listeners = new Set<() => void>();

export function markSettled(revision: string): void {
  if (settled.has(revision)) return;
  settled.add(revision);
  for (const heard of listeners) heard();
}

/** The App left the page: the next time it's shown, its copies wait for it again. */
export function clearSettled(revision: string): void {
  if (settled.delete(revision)) for (const heard of listeners) heard();
}

const subscribe = (heard: () => void) => {
  listeners.add(heard);
  return () => {
    listeners.delete(heard);
  };
};

export function useSettled(revision: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => settled.has(revision),
    () => false,
  );
}

/**
 * An open's moments as the page logs them: each a whole number of milliseconds within ten minutes, or left out (what a
 * frame says is the App's code's to say, so nothing is taken as it comes).
 */
export const openMs = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 600_000 ? Math.round(value) : undefined;

/** A count from the frame, within what the log takes. */
export const openCount = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : 0;
