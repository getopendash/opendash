/**
 * An App's code check, with no shell: its files live in memory, esbuild bundles them through a plugin that answers
 * every import itself (the App's own files, react and `@opendash/app`; nothing else exists), TypeScript checks them
 * against the runtime's types and the App's own ids, and the rules walk the syntax tree. Nothing here runs the App's
 * code. Its page is `/App.tsx`: its default export, registered as it loads. A draft is saved only when its code passes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import ts from "typescript";
import type { Definition } from "../dashboard/definition";
import { appCss, stylesProblems } from "./css";
import { LIMITS } from "./limits";
import { checkRules, type Finding } from "./rules";
import { idsDts, RUNTIME_DTS } from "./types";

export { LIMITS, oversize } from "./limits";
export type { Finding };

/** An App's files: "/App.tsx" → its source, with its components, helpers and stylesheets beside it. */
export type PartFiles = Record<string, string>;

export interface Problem {
  file?: string;
  line?: number;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  /** Bundling and type errors, and anything wrong with the files themselves. */
  errors: Problem[];
  /** The rules: secure, typed figures, style, imports. */
  rules: Finding[];
  /** The bundle, when it bundled (even if other checks failed). */
  bundle?: string;
  bundleHash?: string;
  bytes?: number;
  gzip?: number;
  ms: number;
}

/** What an App's files may be: its code and its stylesheets. */
const APP_EXTENSIONS = [".tsx", ".ts", ".css"];
/** How deep an App's folders go: /pages/customer/Panel.tsx at most. */
const APP_MAX_PARTS = 3;
/** A folder's or a file's name: letters, digits, - and _. */
const PLAIN_NAME = /^[\w-]{1,64}$/;

/**
 * Why a path can't be one of an App's files, or null when it can. Any folders the App likes (a list
 * of allowed folders once refused /pages), each a plain name, ending in a plain name and one extension.
 */
export function appPathProblem(path: string): string | null {
  if (!path.startsWith("/")) return "A file's path starts at the App's root, like /components/Queue.tsx.";
  const parts = path.slice(1).split("/");
  if (parts.length > APP_MAX_PARTS) return `A file sits at most ${APP_MAX_PARTS - 1} folders deep.`;
  const file = parts.at(-1) ?? "";
  const extension = APP_EXTENSIONS.find((x) => file.endsWith(x));
  if (!extension) return `A file is ${APP_EXTENSIONS.join(", ")}.`;
  const names = [...parts.slice(0, -1), file.slice(0, -extension.length)];
  if (!names.every((name) => PLAIN_NAME.test(name)))
    return "Folder and file names are letters, digits, - and _ (no dots, no spaces).";
  return null;
}

/** An App's stylesheets, in path order. */
export const stylesheetsOf = (files: PartFiles) =>
  Object.keys(files)
    .filter((path) => path.endsWith(".css"))
    .sort();

/** Problems with an App's files as files: names, count, size, the page, the stylesheets. */
export function fileProblems(files: PartFiles): Problem[] {
  const out: Problem[] = [];
  const names = Object.keys(files);
  if (names.length && !Object.hasOwn(files, "/App.tsx"))
    out.push({
      message:
        "An App's page, /App.tsx, isn't written yet: write it with these files (nothing is saved until the App builds).",
    });
  if (names.length > LIMITS.files)
    out.push({ message: `An App has at most ${LIMITS.files} files; this one has ${names.length}.` });
  let total = 0;
  for (const name of names) {
    const problem = appPathProblem(name);
    if (problem) out.push({ file: name, message: problem });
    const size = files[name]?.length ?? 0;
    total += size;
    if (size > LIMITS.fileChars)
      out.push({ file: name, message: `A file has at most ${LIMITS.fileChars} characters; split it.` });
  }
  if (total > LIMITS.sourceChars)
    out.push({ message: `An App's files have at most ${LIMITS.sourceChars} characters together.` });
  for (const sheet of stylesheetsOf(files)) {
    for (const message of stylesProblems(files[sheet] ?? "")) out.push({ file: sheet, message });
  }
  return out;
}

// ---- bundle ----------------------------------------------------------------------------------------------------------

/** Where a bundle built to mark its pieces reads its JSX: present in every bundle built since select to edit. */
const JSX_DEV_GLOBAL = "window.__OD_APP__.jsxDevRuntime";

/** Whether a stored bundle marks its pieces (select to edit): one built before it doesn't, and is built again. */
export const marksPieces = (bundle: string): boolean => bundle.includes(JSX_DEV_GLOBAL);

const GLOBALS: Record<string, string> = {
  // The runtime's own React: the App and the runtime draw with one.
  react: "module.exports = window.__OD_APP__.React;",
  "react/jsx-runtime": "module.exports = window.__OD_APP__.jsxRuntime;",
  // The App's JSX, compiled in development form: the runtime's adapter marks each DOM element with its file and line
  // (select to edit), and makes it with the production React.
  "react/jsx-dev-runtime": `module.exports = ${JSX_DEV_GLOBAL};`,
  // The runtime: its data, its primitives.
  "@opendash/app": "module.exports = window.__OD_APP__;",
};
const ENTRY = "/__entry.tsx";

/** The bundle's entry: the App's page, registered with its CSS. */
const entryOf = (css: string) =>
  [
    'import App from "./App";',
    'import { registerApp } from "@opendash/app";',
    `registerApp(App, ${JSON.stringify(css)});`,
    "",
  ].join("\n");

function closedFs(files: PartFiles, css: string): esbuild.Plugin {
  return {
    name: "app-files",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: ENTRY, namespace: "app" };
        if (GLOBALS[args.path]) return { path: args.path, namespace: "od-global" };
        if (args.path.startsWith("./") || args.path.startsWith("../")) {
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(args.importer), args.path));
          for (const c of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
            if (Object.hasOwn(files, c)) return { path: c, namespace: "app" };
          }
          return { errors: [{ text: `There's no file "${args.path}" among the App's files.` }] };
        }
        return {
          errors: [{ text: `An App imports its own files, react and @opendash/app, nothing else: "${args.path}".` }],
        };
      });
      b.onLoad({ filter: /.*/, namespace: "od-global" }, (args) => ({
        contents: GLOBALS[args.path] ?? "",
        loader: "js",
      }));
      b.onLoad({ filter: /.*/, namespace: "app" }, (args) => {
        if (args.path === ENTRY) return { contents: entryOf(css), loader: "tsx" };
        const src = Object.hasOwn(files, args.path) ? files[args.path] : undefined;
        if (src == null) return { errors: [{ text: `There's no file ${args.path} among the App's files.` }] };
        return { contents: src, loader: args.path.endsWith(".ts") ? "ts" : "tsx" };
      });
    },
  };
}

async function bundle(files: PartFiles): Promise<{ ok: true; code: string } | { ok: false; errors: Problem[] }> {
  try {
    const css = await appCss(files);
    const res = await esbuild.build({
      entryPoints: ["entry"],
      bundle: true,
      write: false,
      format: "iife",
      minify: true,
      jsx: "automatic",
      // Each element carries the file and line it was written at, for select to edit (the runtime's jsxDEV turns that
      // into a mark on the DOM). Only the bundle: the type check and the rules read the source as written.
      jsxDev: true,
      target: "es2022",
      charset: "utf8",
      plugins: [closedFs(files, css)],
      logLevel: "silent",
    });
    return { ok: true, code: res.outputFiles[0]?.text ?? "" };
  } catch (e) {
    const failure = e as esbuild.BuildFailure;
    const errors = failure.errors?.map((x) => ({
      file: x.location?.file && x.location.file !== ENTRY ? x.location.file : undefined,
      line: x.location?.line,
      message: x.text,
    })) ?? [{ message: String(e) }];
    return { ok: false, errors };
  }
}

// ---- type check -------------------------------------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const LIB_DIR = path.dirname(require.resolve("typescript/lib/lib.d.ts"));
const REACT_TYPES = path.dirname(require.resolve("@types/react/package.json"));
const CSSTYPE = path.dirname(createRequire(path.join(REACT_TYPES, "package.json")).resolve("csstype/package.json"));
const libCache = new Map<string, ts.SourceFile>();
const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: [],
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  noUnusedLocals: false,
};

/** The compiler host reads four things: the App's files, the two type files, TypeScript's libs and React's types. */
function host(files: PartFiles, dts: string): ts.CompilerHost {
  const virtual = new Map<string, string>(Object.entries(files).map(([p, s]) => [`/app${p}`, s]));
  virtual.set("/types/runtime.d.ts", RUNTIME_DTS);
  virtual.set("/types/ids.d.ts", dts);
  const real = (p: string): string | undefined => {
    if (p.startsWith("/node_modules/@types/react/"))
      return path.join(REACT_TYPES, p.slice("/node_modules/@types/react/".length));
    if (p.startsWith("/node_modules/csstype/")) return path.join(CSSTYPE, p.slice("/node_modules/csstype/".length));
    if (p.startsWith(`${LIB_DIR}/`)) return p;
    return undefined;
  };
  const read = (p: string): string | undefined => {
    if (virtual.has(p)) return virtual.get(p);
    const r = real(p);
    return r && existsSync(r) ? readFileSync(r, "utf8") : undefined;
  };
  return {
    getSourceFile: (p, lang) => {
      const isLib = !virtual.has(p);
      const cached = isLib ? libCache.get(p) : undefined;
      if (cached) return cached;
      const text = read(p);
      if (text == null) return undefined;
      const sf = ts.createSourceFile(p, text, lang, true);
      if (isLib) libCache.set(p, sf);
      return sf;
    },
    getDefaultLibFileName: (o) => path.join(LIB_DIR, ts.getDefaultLibFileName(o)),
    getDefaultLibLocation: () => LIB_DIR,
    writeFile: () => {},
    getCurrentDirectory: () => "/app",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (p) => read(p) != null,
    readFile: read,
    directoryExists: (d) =>
      d === "/" ||
      d.startsWith("/app") ||
      d.startsWith("/node_modules") ||
      d.startsWith("/types") ||
      d.startsWith(LIB_DIR),
    getDirectories: () => [],
  };
}

function typecheck(files: PartFiles, dts: string): Problem[] {
  const roots = [
    "/types/runtime.d.ts",
    "/types/ids.d.ts",
    ...Object.keys(files)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => `/app${f}`),
  ];
  const program = ts.createProgram({ rootNames: roots, options: OPTIONS, host: host(files, dts) });
  return ts.getPreEmitDiagnostics(program).map((d) => ({
    file: d.file?.fileName.startsWith("/app/") ? d.file.fileName.slice(4) : undefined,
    line: d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : undefined,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  }));
}

// ---- the whole check ----------------------------------------------------------------------------------------------

/** Checks an App's code: its files, its bundle, its types against the App's ids, and the rules. */
export async function checkParts(input: { files: PartFiles; definition: Definition }): Promise<CheckResult> {
  const t0 = performance.now();
  const errors = fileProblems(input.files);
  if (errors.length) return { ok: false, errors, rules: [], ms: Math.round(performance.now() - t0) };
  const rules = checkRules(new Map(Object.entries(input.files)));
  const bundled = await bundle(input.files);
  errors.push(...(bundled.ok ? [] : bundled.errors));
  errors.push(...typecheck(input.files, idsDts(input.definition)));
  const code = bundled.ok ? bundled.code : undefined;
  if (code && code.length > LIMITS.bundleBytes) {
    errors.push({
      message: `The App bundles to ${code.length} bytes; at most ${LIMITS.bundleBytes}. Make it smaller.`,
    });
  }
  return {
    ok: errors.length === 0 && rules.length === 0,
    errors: errors.slice(0, 60),
    rules: rules.slice(0, 60),
    ...(code
      ? {
          bundle: code,
          bundleHash: createHash("sha256").update(code).digest("hex"),
          bytes: Buffer.byteLength(code),
          gzip: gzipSync(code).length,
        }
      : {}),
    ms: Math.round(performance.now() - t0),
  };
}

/** A check's problems as text a builder can act on, one per line, at most `max`. */
export function describeProblems(result: CheckResult, max = 30): string {
  const lines = [
    ...result.errors.map((e) => `${e.file ? `${e.file}${e.line ? `:${e.line}` : ""} ` : ""}${e.message}`),
    ...result.rules.map((r) => `${r.file}:${r.line} [${r.rule}] ${r.message}`),
  ];
  return lines.slice(0, max).join("\n") + (lines.length > max ? `\n… and ${lines.length - max} more.` : "");
}

/**
 * A draft's live preview: its code bundled as it stands, with no type check, refused only by the rules that keep the
 * frame safe (never by style or typed figures, which the full check enforces before a version). Fast enough to run on
 * every write. Null when they don't bundle yet (an import of a file not written, a syntax error mid-way): the last
 * preview stays.
 */
export async function previewParts(files: PartFiles): Promise<{ bundle: string; bundleHash: string } | null> {
  if (fileProblems(files).length) return null;
  if (checkRules(new Map(Object.entries(files))).some((r) => r.rule === "secure" || r.rule === "import")) return null;
  const bundled = await bundle(files);
  if (!bundled.ok || !bundled.code || bundled.code.length > LIMITS.bundleBytes) return null;
  return { bundle: bundled.code, bundleHash: createHash("sha256").update(bundled.code).digest("hex") };
}
export { type LookFinding, lookFindings } from "./looks";
