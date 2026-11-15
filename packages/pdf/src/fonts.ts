/**
 * The PDF's fonts, all SIL OFL and kept in `fonts/`: Geist for the text, Geist Mono
 * for code, then a Noto font for each script Geist lacks, then symbols, math and emoji. react-pdf picks, character by
 * character, the first font in the stack that has it. Each script's font comes before Noto Sans Math, which has
 * Arabic letters of its own but not their joining forms. Chinese, Japanese and Korean aren't shipped (about 16 MB),
 * so their characters are drawn as "□" (`text.ts`).
 *
 * react-pdf's font registry is global, and a family registered twice keeps its first files: each family is registered
 * once per process, from the first folder asked for (a process has one: the package's own, or the server build's copy
 * of it). The files are read here too, to measure text (a table's columns) and to know which characters some font has.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Font } from "@react-pdf/renderer";
import * as fontkit from "fontkit";

/**
 * The fonts' folder, kept with this package: where it is when the package runs from its source (the worker). A bundled
 * server (the web app's) passes the place its build traced the files to instead.
 */
export function packageFontDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts");
}

/** A family and its faces: file and weight (500 is bold, as Geist Medium). */
interface Family {
  family: string;
  faces: { file: string; weight: number }[];
}

const GEIST: Family = {
  family: "Geist",
  faces: [
    { file: "Geist-Regular.ttf", weight: 400 },
    { file: "Geist-Medium.ttf", weight: 500 },
  ],
};
const GEIST_MONO: Family = { family: "Geist Mono", faces: [{ file: "GeistMono-Regular.ttf", weight: 400 }] };
const one = (family: string, file: string): Family => ({ family, faces: [{ file, weight: 400 }] });
/** After Geist, in the order react-pdf tries them: each script's own font, then symbols, math and emoji. */
const FALLBACKS: Family[] = [
  {
    family: "Noto Sans",
    faces: [
      { file: "NotoSans-Regular.ttf", weight: 400 },
      { file: "NotoSans-Medium.ttf", weight: 500 },
    ],
  },
  one("Noto Sans Arabic", "NotoSansArabic-Regular.ttf"),
  one("Noto Sans Hebrew", "NotoSansHebrew-Regular.ttf"),
  one("Noto Sans Devanagari", "NotoSansDevanagari-Regular.ttf"),
  one("Noto Sans Thai", "NotoSansThai-Regular.ttf"),
  one("Noto Sans Symbols 2", "NotoSansSymbols2-Regular.ttf"),
  one("Noto Sans Math", "NotoSansMath-Regular.ttf"),
  one("Noto Emoji", "NotoEmoji-Regular.ttf"),
];

/** The font stacks a run is set in. */
export const TEXT_FONTS = [GEIST.family, ...FALLBACKS.map((f) => f.family)];
export const CODE_FONTS = [GEIST_MONO.family, ...FALLBACKS.map((f) => f.family)];

/** Every font file the PDF draws with: the chart images use them too. */
export const FONT_FILES = [GEIST, GEIST_MONO, ...FALLBACKS].flatMap((f) => f.faces.map((face) => face.file));

/** A text's look: as written, bold (Geist Medium), or code (Geist Mono). */
export type Face = "regular" | "bold" | "code";

/** What the drawing needs to know about its fonts. */
export interface Fonts {
  /** The width of `text` at `size`, in points, as `face` draws it (a character Geist lacks, as its fallback's). */
  width(text: string, face: Face, size: number): number;
  /** Whether some font in the stack draws this character. */
  covers(codePoint: number): boolean;
  /** How many of Geist Mono's characters fit `width` at `size`. */
  codeColumns(width: number, size: number): number;
}

let registered: { dir: string; fonts: Promise<Fonts> } | null = null;

/** The part of a fontkit font `keepCharacters` changes. */
interface GlyphSource {
  getGlyph(id: number, codePoints?: number[]): { codePoints: number[] } | null;
}
const kept = new WeakSet<GlyphSource>();

/**
 * A glyph asked for with its characters takes them, if fontkit kept it without. fontkit keeps one glyph object per
 * glyph, with the characters it was first asked for; building a PDF's font subset asks for a letter's parts with none
 * (Cyrillic "р" is drawn from Latin "p"), and a part not drawn yet in the process was kept with no characters.
 * react-pdf's layout maps text to glyphs by those characters, so every PDF after dropped the character beside it
 * ("growth plans" was drawn "growthplans"). Layout always asks with the characters, so it mends the glyph.
 */
function keepCharacters(font: GlyphSource): void {
  if (kept.has(font)) return;
  kept.add(font);
  const getGlyph = font.getGlyph.bind(font);
  font.getGlyph = (id, codePoints = []) => {
    const glyph = getGlyph(id, codePoints);
    if (glyph && glyph.codePoints.length === 0 && codePoints.length > 0) glyph.codePoints = codePoints;
    return glyph;
  };
}

/** The fonts in `fontDir`, registered with react-pdf (once per process) and read for measuring. */
export function pdfFonts(fontDir: string): Promise<Fonts> {
  if (registered?.dir === fontDir) return registered.fonts;
  const fonts = load(fontDir);
  registered = { dir: fontDir, fonts };
  // A folder that can't be read isn't kept, so the next PDF tries again.
  fonts.catch(() => {
    if (registered?.fonts === fonts) registered = null;
  });
  return fonts;
}

async function load(fontDir: string): Promise<Fonts> {
  const read = async (file: string) => {
    const font = fontkit.create(await readFile(path.join(fontDir, file)));
    if (!("unitsPerEm" in font)) throw new Error(`${file} is a font collection`);
    return font;
  };
  const [regular, bold, mono, ...fallbacks] = await Promise.all(
    [
      "Geist-Regular.ttf",
      "Geist-Medium.ttf",
      "GeistMono-Regular.ttf",
      ...FALLBACKS.map((f) => f.faces[0]?.file ?? ""),
    ].map(read),
  );
  if (!regular || !bold || !mono) throw new Error("Geist is missing");

  const known = new Set(Font.getRegisteredFontFamilies());
  for (const f of [GEIST, GEIST_MONO, ...FALLBACKS]) {
    if (known.has(f.family)) continue;
    Font.register({
      family: f.family,
      fonts: f.faces.map((face) => ({ src: path.join(fontDir, face.file), fontWeight: face.weight })),
    });
  }
  // No hyphenation: the page has none, and a long token breaks where `text.ts` cut it.
  Font.registerHyphenationCallback((word) => [word]);
  // Every face loaded now, as react-pdf keeps it for the process, its glyphs kept whole (`keepCharacters`).
  await Promise.all(
    [GEIST, GEIST_MONO, ...FALLBACKS].flatMap((f) =>
      f.faces.map(async (face) => {
        const descriptor = { fontFamily: f.family, fontWeight: face.weight };
        await Font.load(descriptor);
        const font = Font.getFont(descriptor)?.data;
        if (font) keepCharacters(font as unknown as GlyphSource);
      }),
    ),
  );

  const faces: Record<Face, fontkit.Font> = { regular, bold, code: mono };
  const covered = new Map<number, boolean>();
  const covers = (cp: number) => {
    let has = covered.get(cp);
    if (has === undefined) {
      has = regular.hasGlyphForCodePoint(cp) || fallbacks.some((f) => f.hasGlyphForCodePoint(cp));
      covered.set(cp, has);
    }
    return has;
  };
  /** Each character's advance, in em, as `face` or its first fallback with the character draws it. */
  const advances = new Map<string, number>();
  const advance = (ch: string, face: Face) => {
    const key = `${face}${ch}`;
    let em = advances.get(key);
    if (em === undefined) {
      const cp = ch.codePointAt(0) ?? 0;
      const font = [faces[face], ...fallbacks].find((f) => f.hasGlyphForCodePoint(cp)) ?? faces[face];
      em = font.glyphForCodePoint(cp).advanceWidth / font.unitsPerEm;
      if (advances.size < 20_000) advances.set(key, em);
    }
    return em;
  };
  const monoEm = mono.glyphForCodePoint(0x4d).advanceWidth / mono.unitsPerEm;
  return {
    width(text, face, size) {
      let em = 0;
      for (const ch of text) em += advance(ch, face);
      return em * size;
    },
    covers,
    codeColumns: (width, size) => Math.floor(width / (monoEm * size)),
  };
}
