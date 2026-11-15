/**
 * How big an App's code may be. In a module of its own, with nothing imported, so the store can hold work that doesn't
 * build yet to the same sizes without loading the code check (esbuild, TypeScript).
 */
export const LIMITS = {
  files: 40,
  /** All the files together, in characters. */
  sourceChars: 300_000,
  fileChars: 60_000,
  /** The bundle, minified. */
  bundleBytes: 600_000,
} as const;

/** Why these files are over an App's size, or null when they fit: what the build would refuse them for anyway. */
export function oversize(files: Record<string, string>): string | null {
  const names = Object.keys(files);
  if (names.length > LIMITS.files) return `An App has at most ${LIMITS.files} files; this one has ${names.length}.`;
  const total = names.reduce((n, name) => n + (files[name]?.length ?? 0), 0);
  if (total > LIMITS.sourceChars) {
    return `An App's files have at most ${LIMITS.sourceChars.toLocaleString("en-US")} characters together; these have ${total.toLocaleString("en-US")}.`;
  }
  return null;
}
