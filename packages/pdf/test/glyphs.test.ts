// One PDF can't cost the next a character. fontkit keeps one glyph object per glyph, and building a
// PDF's font subset asks for a letter's parts with no characters (Cyrillic "р" is drawn from Latin "p"); react-pdf's
// layout, which maps text to glyphs by their characters, then dropped the character beside every later "p": "growth
// plans" was drawn "growthplans", "Upgrades" "pgrades". Its own file: the first PDF here is the first in the process.
import { inflateSync } from "node:zlib";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFRef } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { renderPdf, textBlocks } from "../src";

/** The text a PDF's first page draws, read back through each font's ToUnicode map, as a viewer copies it. */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const inflate = (s: PDFRawStream) => inflateSync(Buffer.from(s.contents)).toString("latin1");
  const maps = new Map<string, Map<number, string>>();
  for (const [name, ref] of page?.node.Resources()?.lookup(PDFName.of("Font"), PDFDict).entries() ?? []) {
    const unicode = doc.context.lookup(ref as PDFRef, PDFDict).lookup(PDFName.of("ToUnicode"));
    const map = new Map<number, string>();
    if (unicode instanceof PDFRawStream) {
      for (const [, low, list] of inflate(unicode).matchAll(/<([0-9a-f]+)> <[0-9a-f]+> \[([^\]]*)\]/gi)) {
        [...(list ?? "").matchAll(/<([0-9a-f]+)>/gi)].forEach((m, i) => {
          const units = (m[1] ?? "").match(/.{4}/g) ?? [];
          map.set(
            Number.parseInt(low ?? "0", 16) + i,
            String.fromCharCode(...units.map((u) => Number.parseInt(u, 16))),
          );
        });
      }
    }
    maps.set(name.toString(), map);
  }
  const contents = page?.node.Contents();
  let font = "";
  let text = "";
  for (const line of (contents instanceof PDFRawStream ? inflate(contents) : "").split("\n")) {
    font = /^(\/\S+) [\d.]+ Tf/.exec(line)?.[1] ?? font;
    if (!line.endsWith("TJ")) continue;
    for (const [, hex] of line.matchAll(/<([0-9a-f]+)>/gi)) {
      for (const cid of hex?.match(/.{4}/g) ?? []) text += maps.get(font)?.get(Number.parseInt(cid, 16)) ?? "?";
    }
  }
  return text;
}

describe("one PDF after another", () => {
  it("draws every character of the next, whatever the one before drew", async () => {
    // Cyrillic and nothing Latin, so the subset is the first to ask for Latin "p".
    await renderPdf(textBlocks([{ text: "Кириллица" }] as never), "First");
    const next = await renderPdf(
      textBlocks([{ text: "Most of it came from `growth` plans:\n\n> Upgrades, not new accounts." }] as never),
      "Next",
    );
    const text = await drawnText(next);
    expect(text).toContain("Most of it came from growth plans:");
    expect(text).toContain("Upgrades, not new accounts.");
  });
});
