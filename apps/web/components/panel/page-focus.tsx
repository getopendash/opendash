"use client";

import { type PanelFocus, useFocus } from "./panel-context";

/** Names what a server-drawn page shows for the analyst beside it: a released metric, say. */
export function PageFocus({ focus }: { focus: PanelFocus | null }) {
  useFocus(focus);
  return null;
}
