import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import type { Cell } from "./data";

export type Format = "money" | "money-compact" | "number" | "percent" | "date" | "text";

export interface Derived {
  kind: "derived";
  name: string;
  value: number | null;
  inputs: Traced[];
  recipe: string;
}
export interface Assumption {
  kind: "assumption";
  name: string;
  label: string;
  value: number;
  unit: "share" | "money" | "count" | "days";
  setBy: string;
}
export type Traced = Cell | Derived | Assumption;

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdc = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
// Days are UTC days, as a dashboard's periods and a chart's months are.
const date = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

export function format(v: unknown, f: Format = "number", signed = false): string {
  if (v == null || v === "") return "—";
  if (f === "text") return String(v);
  if (f === "date") {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : date.format(d);
  }
  const n = typeof v === "number" ? v : Number(v);
  const sign = signed && n > 0 ? "+" : "";
  switch (f) {
    case "money":
      return sign + usd.format(n);
    case "money-compact":
      return sign + usdc.format(n);
    case "percent":
      return sign + pct.format(n);
    default:
      // A small number keeps what tells it apart: 2.98 isn't 3, 12.4 isn't 12.
      return sign + (Number.isInteger(n) || Math.abs(n) >= 100 ? nf : Math.abs(n) < 10 ? nf2 : nf1).format(n);
  }
}

const numberOf = (t: Traced | null | undefined): number | null => {
  if (!t) return null;
  if (t.kind === "cell") return t.value == null ? null : Number(t.value);
  return t.value;
};

/** A value made in the browser from other traced values. It keeps its inputs and recipe, so it opens like a query cell. */
export function derive(name: string, inputs: Traced[], fn: (...v: number[]) => number, recipe?: string): Derived {
  const vals = inputs.map(numberOf);
  const value = vals.some((v) => v == null) ? null : fn(...(vals as number[]));
  return {
    kind: "derived",
    name,
    value: value == null || Number.isFinite(value) ? value : null,
    inputs,
    recipe: recipe ?? fn.toString(),
  };
}

// ---- declared assumptions: named, with a unit and who set them; an App's only fixed numbers ------------------

interface AssumptionStore {
  all: Map<string, Assumption & { min?: number; max?: number; step?: number }>;
  set(name: string, v: number): void;
  version: number;
}
const AssumptionCtx = createContext<AssumptionStore | null>(null);

export function AssumptionProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const store = useMemo<AssumptionStore>(() => ({ all: new Map(), set: () => {}, version: 0 }), []);
  store.version = version;
  store.set = (name, v) => {
    const a = store.all.get(name);
    if (a) {
      a.value = v;
      setVersion((x) => x + 1);
    }
  };
  return <AssumptionCtx.Provider value={store}>{children}</AssumptionCtx.Provider>;
}

export function useAssumption(
  name: string,
  initial: number,
  meta: { label: string; unit: Assumption["unit"]; setBy: string; min?: number; max?: number; step?: number },
): Assumption {
  const store = useContext(AssumptionCtx);
  if (!store) throw new Error("useAssumption needs the App around it");
  let a = store.all.get(name);
  if (!a) {
    a = { kind: "assumption", name, value: initial, ...meta };
    store.all.set(name, a);
  }
  // A fresh object per render, so derived values recompute when the owner changes it.
  return { ...a };
}

// ---- Value: every number on screen goes through this ----------------------------------------------------------------

/** A number on screen. With `onOpen`, pressing it opens what's behind it (its query's rows). */
export function Value({
  of,
  format: f = "number",
  signed = false,
  onOpen,
  from,
}: {
  of: Traced | null | undefined;
  format?: Format;
  signed?: boolean;
  onOpen?: () => void;
  /** Where it comes from, said on hover ("opendash_demo · Support tickets"). */
  from?: string;
}) {
  if (!of)
    return (
      <span data-od-value="" className="od-value od-empty">
        —
      </span>
    );
  const text = format(of.value, f, signed);
  return onOpen ? (
    <button
      type="button"
      className="od-value"
      data-od-value=""
      title={from ? `From ${from}. Open the rows behind this number` : "Open the rows behind this number"}
      onClick={onOpen}
    >
      {text}
    </button>
  ) : (
    <span className="od-value" data-od-value="" title={from ? `From ${from}` : undefined}>
      {text}
    </span>
  );
}
