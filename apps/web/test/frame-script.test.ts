// A frame's scripts (the runtime, an App's bundle) leave compressed as the request accepts: a frame's sandbox keeps
// nothing between opens, so each open pays for every byte sent.
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { acceptedEncoding, scriptResponse } from "../lib/frame-script";

const script = `window.__OD_APP__.registerApp(() => null);${"// the same line, many times\n".repeat(400)}`;
const asking = (accept?: string) =>
  new Request("http://127.0.0.1:3000/app-frame/b/x/parts.js", accept ? { headers: { "accept-encoding": accept } } : {});

describe("the encoding a frame's script is sent in", () => {
  it("is Brotli when the request takes it, gzip otherwise, and neither when it takes neither", () => {
    expect(acceptedEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(acceptedEncoding("gzip, deflate")).toBe("gzip");
    expect(acceptedEncoding("br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(acceptedEncoding("gzip;q=0")).toBeNull();
    expect(acceptedEncoding("identity")).toBeNull();
    // A wildcard takes what isn't refused by name.
    expect(acceptedEncoding("*")).toBe("br");
    expect(acceptedEncoding("br;q=0, *")).toBe("gzip");
    expect(acceptedEncoding(null)).toBeNull();
  });
});

describe("a frame's script on its way out", () => {
  it("is the same script in every encoding, immutable, and says what it varies by", async () => {
    const br = await scriptResponse(asking("gzip, br"), "a".repeat(64), script);
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(br.headers.get("cache-control")).toContain("immutable");
    expect(br.headers.get("content-type")).toContain("text/javascript");
    const sent = Buffer.from(await br.arrayBuffer());
    expect(Number(br.headers.get("content-length"))).toBe(sent.byteLength);
    expect(sent.byteLength).toBeLessThan(script.length / 4);
    expect(brotliDecompressSync(sent).toString()).toBe(script);

    const gz = await scriptResponse(asking("gzip"), "a".repeat(64), script);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(script);

    const plain = await scriptResponse(asking(), "a".repeat(64), script);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toBe("Accept-Encoding");
    expect(await plain.text()).toBe(script);
  });

  it("sends a tiny script as it is", async () => {
    const small = await scriptResponse(asking("br"), "b".repeat(64), "registerApp()");
    expect(small.headers.get("content-encoding")).toBeNull();
    expect(await small.text()).toBe("registerApp()");
  });
});
