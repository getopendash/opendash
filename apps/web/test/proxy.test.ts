import { describe, expect, it } from "vitest";
import { moveTo } from "../proxy";

const env = { OPENDASH_OLD_HOSTS: "go.example.com", BETTER_AUTH_URL: "https://app.example.com" };
const ask = (url: string, init: RequestInit & { host?: string } = {}) =>
  new Request(url, { ...init, headers: { host: init.host ?? new URL(url).host, ...(init.headers ?? {}) } });

describe("an address the app moved from", () => {
  it("opens a page at the same path and query on the app's own address", () => {
    expect(moveTo(ask("https://go.example.com/dashboards/42?r=7"), env)?.href).toBe(
      "https://app.example.com/dashboards/42?r=7",
    );
    expect(moveTo(ask("https://go.example.com/"), env)?.href).toBe("https://app.example.com/");
  });

  it("never sends anyone to another site, whatever the path says", () => {
    for (const path of ["//evil.example/x", "///evil.example/x", "/\\evil.example/x", "/%2F%2Fevil.example"]) {
      const to = moveTo(ask(`https://go.example.com${path}`), env);
      expect(to?.origin).toBe("https://app.example.com");
    }
  });

  it("reads the address the browser asked for behind a proxy", () => {
    const behind = ask("http://10.0.0.5:3000/settings", { headers: { "x-forwarded-host": "go.example.com" } });
    expect(moveTo(behind, env)?.href).toBe("https://app.example.com/settings");
  });

  it("keeps answering what other services call there, and anything that isn't a page load", () => {
    expect(moveTo(ask("https://go.example.com/api/slack/events"), env)).toBeNull();
    expect(moveTo(ask("https://go.example.com/api/auth/magic-link/verify?token=x"), env)).toBeNull();
    expect(moveTo(ask("https://go.example.com/settings", { method: "POST" }), env)).toBeNull();
  });

  it("leaves the app's own address, other addresses (the frames'), and an empty setting alone", () => {
    expect(moveTo(ask("https://app.example.com/dashboards"), env)).toBeNull();
    expect(moveTo(ask("https://frames.example.com/app-frame/f/x"), env)).toBeNull();
    expect(moveTo(ask("https://go.example.com/dashboards"), { BETTER_AUTH_URL: "https://app.example.com" })).toBeNull();
  });
});
