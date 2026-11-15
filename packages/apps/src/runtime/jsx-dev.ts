// What an App's JSX compiles to (select to edit): the build compiles it in development form, so each element carries
// the file and line it was written at, and this is the `react/jsx-dev-runtime` it imports. It isn't React's own
// jsxDEV (production React has none): each element an App draws as a DOM element gets a `data-od-src` mark, and the
// element is made by the production `jsx`/`jsxs`, key, ref and children as written. Components aren't marked (a mark
// on their props would reach their code, not the DOM): a click maps to the nearest marked element around it instead.
// The App's code never sees or writes the mark; it's added after the App's own props, so it can't be overridden.
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { SOURCE_ATTRIBUTE } from "../select";

/** The namespace the build gives the App's files: `app:/components/Queue.tsx`. The mark names the file alone. */
const APP_NAMESPACE = "app:";

/** The mark for where an element was written, from the source esbuild passes, or null when it passes none. */
export function sourceMark(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const { fileName, lineNumber, columnNumber } = source as {
    fileName?: unknown;
    lineNumber?: unknown;
    columnNumber?: unknown;
  };
  if (typeof fileName !== "string" || typeof lineNumber !== "number") return null;
  const file = fileName.startsWith(APP_NAMESPACE) ? fileName.slice(APP_NAMESPACE.length) : fileName;
  return `${file}:${lineNumber}:${typeof columnNumber === "number" ? columnNumber : 0}`;
}

type Props = Record<string, unknown>;

export function jsxDEV(
  type: unknown,
  props: Props,
  key: unknown,
  isStaticChildren: boolean,
  source?: unknown,
  _self?: unknown,
) {
  const make = (isStaticChildren ? jsxs : jsx) as (type: unknown, props: Props, key?: unknown) => unknown;
  const mark = typeof type === "string" ? sourceMark(source) : null;
  return make(type, mark ? { ...props, [SOURCE_ATTRIBUTE]: mark } : props, key);
}

export { Fragment };
