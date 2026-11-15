/**
 * A table's column widths, the way a browser lays out an `auto` table (the page's own): each column as wide as its
 * widest cell when they all fit; otherwise each at least as wide as its longest unbreakable piece (a whole number, a
 * word), with the room left shared out by how much more each column wants; and when even that doesn't fit, the whole
 * table set smaller, down to SMALLEST of its size. Pure, for tests.
 */

/** A column's widths at the table's own size, in points: its longest unbreakable piece, and its widest cell. */
export interface ColumnWidths {
  min: number;
  max: number;
}

/** The smallest a table is set at, as a share of its size: 10 pt text at 7 pt. */
export const SMALLEST = 0.7;

/**
 * Widths for `columns` with `gap` between them in `available` points, and the scale the table is set at (1 unless
 * its columns' unbreakable pieces don't fit). At SMALLEST the widths still add up to `available`; a piece that's
 * still too wide then breaks (text) or runs into its gap (a number).
 */
export function columnWidths(
  columns: ColumnWidths[],
  available: number,
  gap: number,
): { widths: number[]; gap: number; scale: number } {
  const gaps = gap * Math.max(0, columns.length - 1);
  const room = available - gaps;
  const sum = (pick: (c: ColumnWidths) => number) => columns.reduce((s, c) => s + pick(c), 0);
  const most = sum((c) => Math.max(c.min, c.max));
  if (most <= room) return { widths: columns.map((c) => Math.max(c.min, c.max)), gap, scale: 1 };
  const least = sum((c) => c.min);
  if (least <= room) {
    const share = (room - least) / (most - least);
    return { widths: columns.map((c) => c.min + (Math.max(c.min, c.max) - c.min) * share), gap, scale: 1 };
  }
  // Even the unbreakable pieces don't fit: the whole table smaller, gaps and all.
  const scale = Math.max(SMALLEST, available / (least + gaps));
  const scaledGap = gap * scale;
  const scaledRoom = available - scaledGap * Math.max(0, columns.length - 1);
  return { widths: columns.map((c) => (c.min / least) * scaledRoom), gap: scaledGap, scale };
}
