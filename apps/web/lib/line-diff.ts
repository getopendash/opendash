/** One line of a diff between a definition's released YAML and its draft. */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
  /** In a line changed in place, where its words differ from the other version's: [from, to) in `text`. */
  mark?: [number, number];
}

/** Where two versions of a line differ, by words: what's between their common start and their common end. */
function changedWords(a: string, b: string): { a: [number, number]; b: [number, number] } {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  const len = (t: string[]) => t.join("").length;
  return {
    a: [len(x.slice(0, p)), a.length - len(x.slice(x.length - q))],
    b: [len(y.slice(0, p)), b.length - len(y.slice(y.length - q))],
  };
}

/** Pairs the lines a change rewrote (as many removed as added, together) and marks the words that changed. */
function markChanged(lines: DiffLine[]): void {
  for (let k = 0; k < lines.length; ) {
    let r = k;
    while (lines[r]?.kind === "removed") r++;
    let d = r;
    while (lines[d]?.kind === "added") d++;
    if (r > k && d - r === r - k) {
      for (let n = 0; n < r - k; n++) {
        const removed = lines[k + n] as DiffLine;
        const added = lines[r + n] as DiffLine;
        const w = changedWords(removed.text, added.text);
        if (w.a[0] < w.a[1]) removed.mark = w.a;
        if (w.b[0] < w.b[1]) added.mark = w.b;
      }
    }
    k = Math.max(d, k + 1);
  }
}

/** The most cells of the comparison's table (4 bytes each): a 2,000-line middle on each side. */
const MAX_CELLS = 4_000_000;

/**
 * The lines two texts share, and what one added or the other removed, in order: a longest-common-subsequence diff
 * over lines, as small definitions are (a few hundred lines at most). Each change keeps `context` lines on each side
 * of it; the rest is left out, marked by a gap.
 */
export function lineDiff(before: string, after: string, context = 3): (DiffLine | { kind: "gap"; lines: number })[] {
  const all = { a: before.replace(/\n$/, "").split("\n"), b: after.replace(/\n$/, "").split("\n") };
  // The lines both start and end with are the same, whatever the change: only what's between them is compared.
  let head = 0;
  while (head < all.a.length && head < all.b.length && all.a[head] === all.b[head]) head++;
  let tail = 0;
  while (
    tail < all.a.length - head &&
    tail < all.b.length - head &&
    all.a[all.a.length - 1 - tail] === all.b[all.b.length - 1 - tail]
  ) {
    tail++;
  }
  const a = all.a.slice(head, all.a.length - tail);
  const b = all.b.slice(head, all.b.length - tail);
  const lines: DiffLine[] = all.a.slice(0, head).map((text) => ({ kind: "same", text }));
  // The longest common run of lines from a[i..] and b[j..], at i * w + j. A middle too big to compare (a rewrite of
  // thousands of lines) shows as removed, then added.
  const w = b.length + 1;
  const lcs = a.length * b.length <= MAX_CELLS ? new Int32Array((a.length + 1) * w) : null;
  const at = (i: number, j: number) => lcs?.[i * w + j] ?? 0;
  if (lcs) {
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
  }
  let i = 0;
  let j = 0;
  while (lcs && i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      lines.push({ kind: "removed", text: a[i++] as string });
    } else {
      lines.push({ kind: "added", text: b[j++] as string });
    }
  }
  while (i < a.length) lines.push({ kind: "removed", text: a[i++] as string });
  while (j < b.length) lines.push({ kind: "added", text: b[j++] as string });
  for (const text of all.a.slice(all.a.length - tail)) lines.push({ kind: "same", text });
  markChanged(lines);

  // Keep `context` lines around each change; fold the rest (a single line is shown: folding it saves nothing).
  const near = new Set<number>();
  lines.forEach((l, k) => {
    if (l.kind === "same") return;
    for (let d = -context; d <= context; d++) near.add(k + d);
  });
  const out: (DiffLine | { kind: "gap"; lines: number })[] = [];
  let folded: DiffLine[] = [];
  const fold = () => {
    if (folded.length === 1) out.push(folded[0] as DiffLine);
    else if (folded.length) out.push({ kind: "gap", lines: folded.length });
    folded = [];
  };
  lines.forEach((l, k) => {
    if (near.has(k)) {
      fold();
      out.push(l);
    } else folded.push(l);
  });
  if (out.length) fold();
  return out;
}
