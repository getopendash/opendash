// The kit's controls: a popover, the date range (presets, a picked range on a two-month
// calendar), and a value picker (one or several values, listed or from the warehouse, searched, with their counts).
// Drawn in the kit's tokens, keyboard first: Escape closes, the trigger keeps focus, every choice is a button.
import { createContext, type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/**
 * In a page's filter bar a control carries its name inside it ("Plan · All"), one 32 px row; elsewhere (a column's
 * filter) the name sits above.
 */
export const InlineLabels = createContext(false);

/** A panel under its trigger: opens on press, closes on Escape, a press outside, or a choice that ends it. */
export function Popover({
  label,
  summary,
  open,
  onOpen,
  children,
  width = 320,
}: {
  label: string;
  summary: ReactNode;
  open: boolean;
  onOpen(open: boolean): void;
  /** Its panel; a function is given `close`, which closes it and gives focus back to its trigger. */
  children: ReactNode | ((close: () => void) => ReactNode);
  width?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const inline = useContext(InlineLabels);
  const close = () => {
    onOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, onOpen]);
  return (
    <div className={cx("od-field od-pop", inline && "od-pop-inline")} ref={root}>
      {inline ? null : <span id={`${id}-l`}>{label}</span>}
      <button
        ref={trigger}
        type="button"
        className="od-pop-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${id}-l ${id}-v`}
        onClick={() => onOpen(!open)}
      >
        {inline ? (
          <span id={`${id}-l`} className="od-pop-key">
            {label}
          </span>
        ) : null}
        <span id={`${id}-v`} className="od-pop-value">
          {summary}
        </span>
        <span className="od-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="od-pop-panel" role="dialog" aria-label={label} style={{ width }}>
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

// ---- dates ---------------------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return { y, m, d };
};
/** "5 Jan" or "5 Jan 2026". */
export const dayLabel = (s: string, year = false) => {
  const { y, m, d } = parse(s);
  return `${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ""}`;
};
/** A picked range as words: "5 Jan – 10 Feb 2026". */
export const rangeLabel = (value: string) => {
  const [from, to] = value.split("..") as [string, string];
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${dayLabel(from, !sameYear)} – ${dayLabel(to, true)}`;
};

function Month({
  year,
  month,
  from,
  to,
  onPick,
}: {
  year: number;
  month: number;
  from: string | null;
  to: string | null;
  onPick(day: string): void;
}) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Weeks start on Monday.
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array.from({ length: lead }, () => null)];
  for (let d = 1; d <= days; d++) cells.push(iso(year, month, d));
  return (
    <div className="od-cal-month">
      <p className="od-cal-title">
        {MONTHS[month - 1]} {year}
      </p>
      <div className="od-cal-grid">
        {["M", "T", "W", "T", "F", "S", "S"].map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: weekday initials repeat
          <span key={i} className="od-cal-wd" aria-hidden>
            {w}
          </span>
        ))}
        {cells.map((c, i) =>
          c ? (
            <button
              key={c}
              type="button"
              className={cx(
                "od-cal-day",
                (c === from || c === to) && "od-cal-end",
                from && to && c > from && c < to && "od-cal-in",
              )}
              aria-pressed={c === from || c === to}
              aria-label={dayLabel(c, true)}
              onClick={() => onPick(c)}
            >
              {Number(c.slice(8))}
            </button>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: blank days before the first
            <span key={`b${i}`} />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A period filter's control: its presets, or a range picked on two months (the first press its first day, the second
 * its last), applied together. The value it sets is the server's to check: a preset, a month, or `from..to`.
 */
export function DateRange({
  label,
  value,
  presets,
  onChange,
}: {
  label: string;
  value: string;
  presets: { value: string; label: string }[];
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const picked = value.includes("..") ? (value.split("..") as [string, string]) : null;
  const [from, setFrom] = useState<string | null>(picked?.[0] ?? null);
  const [to, setTo] = useState<string | null>(picked?.[1] ?? null);
  const today = new Date();
  const [view, setView] = useState(() => {
    const start = picked ? parse(picked[0]) : { y: today.getUTCFullYear(), m: today.getUTCMonth() + 1, d: 1 };
    // The month before and this one: a range that ends today is drawn whole.
    return start.m === 1 ? { y: start.y - 1, m: 12 } : { y: start.y, m: start.m - 1 };
  });
  const next = view.m === 12 ? { y: view.y + 1, m: 1 } : { y: view.y, m: view.m + 1 };
  const shift = (n: number) =>
    setView((v) => {
      const i = v.y * 12 + (v.m - 1) + n;
      return { y: Math.floor(i / 12), m: (i % 12) + 1 };
    });
  const pick = (day: string) => {
    if (!from || (from && to)) {
      setFrom(day);
      setTo(null);
    } else if (day < from) {
      setTo(from);
      setFrom(day);
    } else setTo(day);
  };
  const summary = picked
    ? rangeLabel(value)
    : (presets.find((p) => p.value === value)?.label ?? (/^\d{4}-\d{2}$/.test(value) ? value : value));
  return (
    <Popover label={label} summary={summary} open={open} onOpen={setOpen} width={560}>
      {(close) => (
        <div className="od-range">
          <ul className="od-range-presets">
            {presets.map((p) => (
              <li key={p.value}>
                <button
                  type="button"
                  className={cx("od-option", p.value === value && "od-option-on")}
                  aria-pressed={p.value === value}
                  onClick={() => {
                    onChange(p.value);
                    close();
                  }}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="od-range-cal">
            <div className="od-cal-nav">
              <button type="button" className="od-icon-btn" aria-label="Earlier months" onClick={() => shift(-1)}>
                ‹
              </button>
              <span className="od-cal-pick">
                {from
                  ? to
                    ? `${dayLabel(from, true)} – ${dayLabel(to, true)}`
                    : `From ${dayLabel(from, true)}…`
                  : "Pick a first day"}
              </span>
              <button type="button" className="od-icon-btn" aria-label="Later months" onClick={() => shift(1)}>
                ›
              </button>
            </div>
            <div className="od-cal-months">
              <Month year={view.y} month={view.m} from={from} to={to} onPick={pick} />
              <Month year={next.y} month={next.m} from={from} to={to} onPick={pick} />
            </div>
            <div className="od-pop-actions">
              <button
                type="button"
                className="od-btn"
                disabled={!from || !to}
                onClick={() => {
                  if (from && to) onChange(`${from}..${to}`);
                  close();
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
}

// ---- values ------------------------------------------------------------------------------------------------------

/** A choice of values: one or several, from a list or the warehouse (with counts), searched as you type. */
export function ValuePicker({
  label,
  value,
  multiple,
  searchable,
  options,
  loading,
  onSearch,
  onChange,
  onOpenChange,
  allLabel = "All",
}: {
  label: string;
  value: string[];
  multiple: boolean;
  searchable: boolean;
  /** The values on offer now (a search narrows them), with how many rows have each when the warehouse said. */
  options: { value: string; count?: number }[];
  loading?: boolean;
  /** Called 250 ms after the last key (the older request is the caller's to drop). */
  onSearch?(text: string): void;
  onChange(value: string[]): void;
  /** Told when it opens and closes (the caller asks the warehouse only while it's open). */
  onOpenChange?(open: boolean): void;
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: told on each change of open
  useEffect(() => onOpenChange?.(open), [open]);
  const [text, setText] = useState("");
  // Asked only while it's open: at once on opening, then 250 ms after the last key.
  const opened = useRef(false);
  useEffect(() => {
    if (!onSearch || !open) return;
    const t = setTimeout(() => onSearch(text), opened.current ? 250 : 0);
    opened.current = true;
    return () => clearTimeout(t);
  }, [text, onSearch, open]);
  const shown = onSearch ? options : options.filter((o) => o.value.toLowerCase().includes(text.trim().toLowerCase()));
  const summary = !value.length ? allLabel : value.length <= 2 ? value.join(", ") : `${value.length} chosen`;
  const toggle = (v: string, close: () => void) => {
    if (!multiple) {
      onChange(value[0] === v ? [] : [v]);
      close();
      return;
    }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  return (
    <Popover label={label} summary={summary} open={open} onOpen={setOpen}>
      {(close) => (
        <div className="od-picker">
          {searchable ? (
            <input
              className="od-picker-search"
              type="search"
              placeholder="Search"
              aria-label={`Search ${label}`}
              value={text}
              // biome-ignore lint/a11y/noAutofocus: the panel opened to search
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
          ) : null}
          {value.length && multiple ? (
            <div className="od-tokens">
              {value.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="od-token"
                  onClick={() => toggle(v, close)}
                  aria-label={`Remove ${v}`}
                >
                  {v} <span aria-hidden>×</span>
                </button>
              ))}
            </div>
          ) : null}
          <ul className="od-picker-list" aria-busy={loading || undefined}>
            {shown.map((o) => {
              const on = value.includes(o.value);
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    className={cx("od-option", on && "od-option-on")}
                    aria-pressed={on}
                    onClick={() => toggle(o.value, close)}
                  >
                    <span className={cx("od-check", !multiple && "od-radio")} aria-hidden>
                      {on ? "✓" : ""}
                    </span>
                    <span className="od-option-label">{o.value}</span>
                    {o.count !== undefined ? <span className="od-count">{o.count.toLocaleString("en-US")}</span> : null}
                  </button>
                </li>
              );
            })}
            {!shown.length ? <li className="od-picker-none">{loading ? "Looking…" : "Nothing matches."}</li> : null}
          </ul>
          <div className="od-pop-actions">
            <button type="button" className="od-btn-quiet" disabled={!value.length} onClick={() => onChange([])}>
              {allLabel}
            </button>
            {multiple ? (
              <button type="button" className="od-btn" onClick={close}>
                Done
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Popover>
  );
}
