import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { addressAllowed, NetworkRefused, tcpReach, vetHost } from "../src/network";

describe("addressAllowed", () => {
  it.each([
    "0.0.0.0",
    "169.254.169.254", // cloud metadata
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "fe80::1",
    "ff02::1",
    "::ffff:169.254.169.254",
    // The same metadata address, hidden in other IPv6 forms.
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "::169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "::ffff:0:a9fe:a9fe", // IPv4-translated
    "::ffff:0:169.254.169.254",
    "64:ff9b:1::a9fe:a9fe", // local-use NAT64
    "fd00:ec2::254", // AWS metadata over IPv6
    "100.100.100.200", // Alibaba metadata
    "192.0.2.10",
    "198.18.0.1",
    "2001:db8::1",
    "fe80::1%lo0",
  ])("never allows %s", (ip) => {
    expect(addressAllowed(ip, "community").allowed).toBe(false);
    expect(addressAllowed(ip, "cloud").allowed).toBe(false);
  });

  it.each([
    "10.1.2.3",
    "172.16.0.5",
    "172.31.255.255",
    "192.168.1.10",
    "127.0.0.1",
    "100.64.0.1",
    "::1",
    "fd12::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "2002:c0a8:101::1",
  ])("allows private %s on self-hosted installs only", (ip) => {
    expect(addressAllowed(ip, "community").allowed).toBe(true);
    expect(addressAllowed(ip, "cloud")).toEqual({ allowed: false, reason: "a private address" });
  });

  it.each(["8.8.8.8", "172.32.0.1", "52.29.1.1", "2a00:1450:4001::1"])("allows public %s everywhere", (ip) => {
    expect(addressAllowed(ip, "community").allowed).toBe(true);
    expect(addressAllowed(ip, "cloud").allowed).toBe(true);
  });

  it("rejects things that aren't addresses", () => {
    expect(addressAllowed("db.example.com", "community").allowed).toBe(false);
  });
});

describe("vetHost", () => {
  it("returns every address that may be tried", async () => {
    await expect(vetHost("127.0.0.1", "community")).resolves.toEqual(["127.0.0.1"]);
    const local = await vetHost("localhost", "community");
    expect(local.length).toBeGreaterThan(0);
    for (const address of local) expect(["127.0.0.1", "::1"]).toContain(address);
  });

  it("refuses a name that resolves to a private address in cloud", async () => {
    await expect(vetHost("localhost", "cloud")).rejects.toBeInstanceOf(NetworkRefused);
    await expect(vetHost("169.254.169.254", "community")).rejects.toThrow(/link-local/);
  });
});

describe("tcpReach", () => {
  it("never dials once its run is stopped", async () => {
    let dialled = 0;
    const server = createServer(() => {
      dialled += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const stop = new AbortController();
      stop.abort();
      await expect(tcpReach("127.0.0.1", port, 1_000, stop.signal)).rejects.toMatchObject({ code: "ABORTED" });
      expect(await tcpReach("127.0.0.1", port, 1_000)).toBeGreaterThanOrEqual(0);
      await new Promise((r) => setTimeout(r, 50));
      expect(dialled).toBe(1);
    } finally {
      server.close();
    }
  });
});
