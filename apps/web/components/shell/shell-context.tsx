"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

interface ShellState {
  /** Desktop: the sidebar is a rail of icons, with a button to bring it back. */
  collapsed: boolean;
  /** The sidebar has been toggled here: from then on it changes width smoothly (never on a load). */
  animate: boolean;
  /** Below lg: the sidebar is open as a drawer over the sheet. */
  drawerOpen: boolean;
  toggle: () => void;
  closeDrawer: () => void;
}

const ShellContext = createContext<ShellState | null>(null);
/** Where it was kept before the cookie: read once, so a collapsed sidebar stays collapsed. */
const OLD_KEY = "opendash.sidebar-collapsed";
const remember = (rail: boolean) => {
  // biome-ignore lint/suspicious/noDocumentCookie: one small preference, read by the server on the next load
  document.cookie = `${SIDEBAR_COOKIE}=${rail ? "rail" : "full"}; path=/; max-age=31536000; samesite=lax`;
};

export function ShellProvider({ rail = false, children }: { rail?: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(rail);
  const [animate, setAnimate] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (document.cookie.includes(`${SIDEBAR_COOKIE}=`)) return;
    try {
      if (localStorage.getItem(OLD_KEY) === "1") {
        setCollapsed(true);
        remember(true);
      }
      localStorage.removeItem(OLD_KEY);
    } catch {
      // Storage can be unavailable (private windows); the sidebar just starts open.
    }
  }, []);

  const toggle = useCallback(() => {
    if (window.matchMedia("(min-width: 64rem)").matches) {
      setAnimate(true);
      setCollapsed((c) => {
        remember(!c);
        return !c;
      });
    } else {
      setDrawerOpen((o) => !o);
    }
  }, []);

  return (
    <ShellContext.Provider value={{ collapsed, animate, drawerOpen, toggle, closeDrawer: () => setDrawerOpen(false) }}>
      {children}
    </ShellContext.Provider>
  );
}

export function useShell(): ShellState {
  const state = useContext(ShellContext);
  if (!state) throw new Error("useShell must be used inside <ShellProvider>");
  return state;
}
