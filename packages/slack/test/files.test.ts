// The file reader: text and Markdown read by content, bounded; everything else refused, saying why.
import { describe, expect, it } from "vitest";
import { isSlackFile, plainName, readFiles } from "../src";

const file = (name: string, content: string | Uint8Array, mimeType?: string) => {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return {
    name,
    size: data.byteLength,
    url: `https://files.slack.com/files-pri/T0ACME-F0001/${encodeURIComponent(name)}`,
    ...(mimeType ? { mimeType } : {}),
    fetchData: async () => data,
  };
};

describe("reading files people attach", () => {
  it("reads text and Markdown, and names what it doesn't read and why", async () => {
    const { read, notes } = await readFiles([
      file("q3-targets.md", "# Q3\nMRR target: $400,000"),
      file("notes.txt", "Board meets Thursday."),
      file("pipeline.csv", "a,b\n1,2", "text/csv"),
      file("chart.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"),
      file("binary.md", new Uint8Array([0xff, 0xfe, 0x00, 0x41])),
      file("nul.txt", "a\u0000b"),
    ]);
    expect(read).toEqual([
      { name: "q3-targets.md", text: "# Q3\nMRR target: $400,000" },
      { name: "notes.txt", text: "Board meets Thursday." },
    ]);
    expect(notes).toEqual([
      "pipeline.csv wasn't read: I read text and Markdown files, up to 1 MB each.",
      "chart.png wasn't read: I read up to 3 files a message.",
      "binary.md wasn't read: I read up to 3 files a message.",
      "nul.txt wasn't read: I read up to 3 files a message.",
    ]);
  });

  it("refuses CSV, images, non-UTF-8 and NUL bytes, and over 1 MB, one by one", async () => {
    const one = async (f: ReturnType<typeof file>) => (await readFiles([f])).notes[0];
    expect(await one(file("pipeline.csv", "a,b\n1,2", "text/csv"))).toBe(
      "pipeline.csv wasn't read: I read text and Markdown files, up to 1 MB each.",
    );
    expect(await one(file("chart.png", new Uint8Array([0x89, 0x50]), "image/png"))).toBe(
      "chart.png wasn't read: I read text and Markdown files, up to 1 MB each.",
    );
    expect(await one(file("binary.md", new Uint8Array([0xff, 0xfe, 0x41])))).toBe(
      "binary.md wasn't read: it isn't plain text.",
    );
    expect(await one(file("nul.txt", "a\u0000b"))).toBe("nul.txt wasn't read: it isn't plain text.");
    expect(await one(file("big.md", "x".repeat(1024 * 1024 + 1)))).toBe("big.md wasn't read: it's over 1 MB.");
  });

  it("keeps the first 64 KB of a long file, on a character boundary, and says so", async () => {
    const long = `${"é".repeat(40_000)}tail`;
    const { read, notes } = await readFiles([file("long.md", long)]);
    expect(Buffer.byteLength(read[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(read[0]?.text.endsWith("é")).toBe(true);
    expect(notes).toEqual(["Only the first 64 KB of long.md were read."]);
  });

  it("fetches only Slack's own file host, never an address a message names", async () => {
    let fetched = false;
    const elsewhere = {
      name: "notes.md",
      url: "http://169.254.169.254/latest/meta-data/",
      fetchData: async () => {
        fetched = true;
        return Buffer.from("secret");
      },
    };
    expect((await readFiles([elsewhere])).notes).toEqual(["notes.md wasn't read: it isn't a file shared in Slack."]);
    expect(fetched).toBe(false);
    expect(isSlackFile("https://files.slack.com/files-pri/T1-F1/a.md")).toBe(true);
    for (const url of [
      "http://files.slack.com/a",
      "https://files.slack.com.evil.test/a",
      "https://u:p@files.slack.com/a",
      "https://files.slack.com:8443/a",
    ]) {
      expect(isSlackFile(url), url).toBe(false);
    }
  });

  it("keeps a file's name plain", () => {
    expect(plainName("../../etc/passwd.md")).toBe("passwd.md");
    expect(plainName("a\u0007b.txt")).toBe("ab.txt");
    expect(plainName("")).toBe("file");
  });
});
