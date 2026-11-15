// The reference reader: text as it is, HTML as its words (never its scripts), PDF as its text,
// images as themselves (judged by their bytes, not their names), and anything else refused in words.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReference } from "../src";
import { pdfText } from "../src/context/reader";

const bytes = (s: string) => new TextEncoder().encode(s);
// A one-page PDF made with pdf-lib: "Q3 targets: MRR 400,000".
const PDF =
  "JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAxMTYKPj4Kc3RyZWFtCnicHco7CgJBEEXRvFZRsSC+rk9XD4jgDwxMhNqAyCgjGigy69eRCye6L9okgafeN1oc+sfYf4bLeR7omjVE67gY55Xk55HKfy3s4AA4n7T0oioIqyWkRvWwUF0LbOfiIlBTKGQ7qVhx3ilntE860RcIPRslCmVuZHN0cmVhbQplbmRvYmoKCjcgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL09ialN0bQovTiA1Ci9GaXJzdCAyNgovTGVuZ3RoIDM2Nwo+PgpzdHJlYW0KeJzVUk1LxDAQvedXzFEPbibpR1pZFvarCiIuKiiKh9qGpbIk0mZl/ffOtKvLHsSzlEcyM2+Sl85TgKAhjiECk0EMSaQhAaMMjMdC3n++W5Crcm07Ia+auoNn4iDcwouQc791AZSYTMSBOy9DufFrMTSBYvI3Y9X6elvZFsbFsigQDSKmMSFF1Ata54ScoCmmms5oTzDxHpQzEWI0pVoxIDVDD9d7brLvX9JK3JQ5i4EbZ0P8cy/ftRzO0H/pySdCXvt6UQYLJ4tzjTpVCjOFEWrzdEq/o7Vl8P/3cb3+xrtfX3g0Zx4vD7m17IF+yvLWdn7bVjR25hWeKry5tJsPG5qqPDOYZ6TTZDl5bG8M+Xjz+marnsrhchcu7gJrGBKcu7Z1U878jtyH9CV5MtIZZLEa0UnkxKlzPrA3e1e6QJo4SvdOPRLOsoS8276GPuSkEnJWdrYXfFBLUlzl68atQT40buq65jvBJ34BgVLHJAplbmRzdHJlYW0KZW5kb2JqCgo4IDAgb2JqCjw8Ci9TaXplIDkKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL1hSZWYKL0xlbmd0aCA0MQovVyBbIDEgMiAyIF0KL0luZGV4IFsgMCA5IF0KPj4Kc3RyZWFtCnicFcSxEQAgDAOxt8MdLfuX7MNMCVYhoNtsSEpOlZY4IN7PFwZh8AO6CmVuZHN0cmVhbQplbmRvYmoKCnN0YXJ0eHJlZgo2NzQKJSVFT0Y=";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("the reference reader", () => {
  it("reads text, CSV and Markdown as they are", async () => {
    expect(await readReference({ name: "targets.csv", bytes: bytes("team,target\nEU,40") })).toEqual({
      kind: "file",
      name: "targets.csv",
      text: "team,target\nEU,40",
    });
  });

  it("reads HTML as its words, never its scripts or styles", async () => {
    const r = await readReference({
      name: "page.html",
      bytes: bytes(
        "<html><head><style>p{}</style><script>steal()</script></head><body><h1>Plan</h1><p>Grow EU &amp; US</p><script>x()</script></body></html>",
      ),
    });
    expect(r).toMatchObject({ kind: "file" });
    const text = (r as { text: string }).text;
    expect(text).toContain("Plan");
    expect(text).toContain("Grow EU & US");
    expect(text).not.toMatch(/steal|x\(\)|p\{\}/);
  });

  it("drops a script that never closes, and the rest of the page with it, quickly", async () => {
    const hostile = `<p>Kept</p>${"<script>".repeat(20_000)}x`;
    const started = Date.now();
    const r = await readReference({ name: "bad.html", bytes: bytes(hostile) });
    expect(Date.now() - started).toBeLessThan(500);
    expect((r as { text: string }).text).toBe("Kept");
  });

  it("stays quick on a page of many short comments and nothing else", async () => {
    const started = Date.now();
    const r = await readReference({
      name: "c.html",
      bytes: bytes(`<p>Top</p>${"<!--x-->".repeat(150_000)}<p>End</p>`),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect((r as { text: string }).text).toBe("Top\nEnd");
  });

  it("reads a PDF's text", async () => {
    const r = await readReference({ name: "q3.pdf", bytes: Uint8Array.from(Buffer.from(PDF, "base64")) });
    expect(r).toMatchObject({ kind: "file", name: "q3.pdf" });
    expect((r as { text: string }).text).toContain("Q3 targets: MRR 400,000");
  });

  it("reads a PDF in a process of its own, killed when it runs too long or takes too much memory", async () => {
    const pdf = Uint8Array.from(Buffer.from(PDF, "base64"));
    expect(await pdfText(pdf)).toMatchObject({ ok: true, pages: 1, numPages: 1 });
    expect(await pdfText(pdf, { ms: 1 })).toEqual({ ok: false, why: "slow" });
    // A process that takes memory without end (outside the JS heap, as a PDF's buffers would) is killed at its cap.
    const greedy =
      "const a = []; setInterval(() => { for (let i = 0; i < 8; i++) a.push(Buffer.alloc(16 * 1024 * 1024, 1)); }, 20);";
    expect(await pdfText(pdf, { memoryMb: 128, code: greedy })).toEqual({ ok: false, why: "large" });
    // No secret reaches it.
    const env =
      "process.stdout.write(JSON.stringify({ ok: true, text: Object.keys(process.env).join(','), pages: 0, numPages: 0 }))";
    process.env.OD_READER_SECRET = "s";
    const seen = await pdfText(pdf, { code: env });
    delete process.env.OD_READER_SECRET;
    expect(seen.ok && seen.text.split(",")).toContain("PATH");
    expect(seen.ok && seen.text).not.toContain("OD_READER_SECRET");
    // The server goes on reading after them.
    expect(await pdfText(pdf)).toMatchObject({ ok: true });
  });

  it("reads all of a long answer from its process", async () => {
    const pdf = Uint8Array.from(Buffer.from(PDF, "base64"));
    const long = `const out = JSON.stringify({ ok: true, text: "x".repeat(150000), pages: 1, numPages: 1 });
      process.stdout.write(out, () => process.exit(0));`;
    const r = await pdfText(pdf, { code: long });
    expect(r.ok && r.text.length).toBe(150000);
  });

  it("reads at most two PDFs at once, and a read that waits too long gives up its place", async () => {
    const pdf = Uint8Array.from(Buffer.from(PDF, "base64"));
    // Each says how many readers were alive when it ran (a file per reader, in a folder of its own).
    const dir = mkdtempSync(join(tmpdir(), "od-pdf-"));
    const count = `const fs = require("fs"); const me = ${JSON.stringify(dir)} + "/" + process.pid; fs.writeFileSync(me, "");
      setTimeout(() => { const n = fs.readdirSync(${JSON.stringify(dir)}).length; fs.unlinkSync(me);
      process.stdout.write(JSON.stringify({ ok: true, text: String(n), pages: 0, numPages: 0 })); }, 300);`;
    const first = [1, 2].map(() => pdfText(pdf, { code: count }));
    // Both places taken: this one waits, gives up after 50 ms, and leaves no place behind for a third reader.
    const slow = pdfText(pdf, { code: count, ms: 50 });
    const rest = [3, 4, 5].map(() => pdfText(pdf, { code: count }));
    expect(await slow).toEqual({ ok: false, why: "slow" });
    const all = await Promise.all([...first, ...rest]);
    expect(all.every((r) => r.ok && Number(r.text) <= 2)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes an image by its bytes, and refuses what it can't read", async () => {
    expect(await readReference({ name: "chart.jpg", bytes: PNG })).toMatchObject({
      kind: "image",
      mediaType: "image/png",
    });
    expect(
      await readReference({ name: "a.exe", bytes: Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0xff]) }),
    ).toMatchObject({
      kind: "refused",
    });
    expect(await readReference({ name: "fake.pdf", bytes: bytes("%PDF-not really") })).toMatchObject({
      kind: "refused",
      note: expect.stringContaining("couldn't be read as a PDF"),
    });
  });
});
