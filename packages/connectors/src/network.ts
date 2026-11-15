/**
 * Where OpenDash may connect when someone types in a host (SSRF).
 *   - Never: unspecified, link-local (cloud metadata lives at 169.254.169.254), multicast and reserved ranges.
 *   - Cloud only refuses private ranges too (RFC 1918, loopback, CGNAT, IPv6 unique-local): a tenant must not be able
 *     to reach our own network. Self-hosted installs allow them, because their databases usually live there.
 * The host is resolved once and OpenDash connects to the vetted address, so a DNS answer that changes between the
 * check and the connection (rebinding) can't redirect it.
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP, Socket } from "node:net";

export type Edition = "community" | "cloud";

const never = new BlockList();
never.addSubnet("0.0.0.0", 8, "ipv4");
never.addSubnet("169.254.0.0", 16, "ipv4");
never.addSubnet("192.0.0.0", 24, "ipv4");
never.addSubnet("192.0.2.0", 24, "ipv4");
never.addSubnet("198.18.0.0", 15, "ipv4");
never.addSubnet("198.51.100.0", 24, "ipv4");
never.addSubnet("203.0.113.0", 24, "ipv4");
never.addSubnet("224.0.0.0", 4, "ipv4");
never.addSubnet("240.0.0.0", 4, "ipv4");
never.addAddress("::", "ipv6");
never.addSubnet("100::", 64, "ipv6");
never.addSubnet("2001::", 32, "ipv6"); // Teredo: the IPv4 inside is obfuscated, so it can't be vetted
never.addSubnet("2001:db8::", 32, "ipv6");
never.addSubnet("fe80::", 10, "ipv6");
never.addSubnet("ff00::", 8, "ipv6");
never.addSubnet("64:ff9b:1::", 48, "ipv6"); // local-use NAT64: where the IPv4 sits depends on the prefix length
// Cloud metadata endpoints that aren't link-local, refused in every edition (a self-host may run on these clouds).
never.addSubnet("fd00:ec2::", 32, "ipv6"); // AWS IMDS and DNS over IPv6 (fd00:ec2::254, ::253)
never.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata

const internal = new BlockList();
internal.addSubnet("10.0.0.0", 8, "ipv4");
internal.addSubnet("172.16.0.0", 12, "ipv4");
internal.addSubnet("192.168.0.0", 16, "ipv4");
internal.addSubnet("127.0.0.0", 8, "ipv4");
internal.addSubnet("100.64.0.0", 10, "ipv4");
internal.addAddress("::1", "ipv6");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addSubnet("fec0::", 10, "ipv6");

/** The eight 16-bit groups of an IPv6 address, or null. Handles "::", a zone id and a trailing dotted IPv4. */
function hextets(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? null : tail ? tail.split(":") : [];
  const groups = right === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const values = groups.map((g) => Number.parseInt(g, 16));
  return values.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffff) ? values : null;
}

const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The IPv4 address an IPv6 address carries, in any form that routes to it: IPv4-mapped (::ffff:a.b.c.d, also written
 * in hex as ::ffff:a9fe:a9fe), IPv4-translated (::ffff:0:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64
 * (64:ff9b::/96) and 6to4 (2002::/16).
 */
function embeddedIpv4(ip: string): string | null {
  const h = hextets(ip);
  if (!h) return null;
  const [h0, h1, h2, , h4, h5, h6, h7] = h as [number, number, number, number, number, number, number, number];
  const zeroPrefix = h.slice(0, 5).every((x) => x === 0);
  if (zeroPrefix && h5 === 0xffff) return ipv4Of(h6, h7);
  if (h.slice(0, 4).every((x) => x === 0) && h4 === 0xffff && h5 === 0) return ipv4Of(h6, h7);
  if (zeroPrefix && h5 === 0 && !(h6 === 0 && h7 <= 1)) return ipv4Of(h6, h7);
  if (h0 === 0x64 && h1 === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return ipv4Of(h6, h7);
  if (h0 === 0x2002) return ipv4Of(h1, h2);
  return null;
}

export function addressAllowed(ip: string, edition: Edition): { allowed: true } | { allowed: false; reason: string } {
  const family = isIP(ip);
  if (!family) return { allowed: false, reason: "not an IP address" };
  if (family === 6) {
    // An IPv6 address that carries an IPv4 one is judged as that IPv4 address.
    const inner = embeddedIpv4(ip);
    if (inner) return addressAllowed(inner, edition);
  }
  const address = family === 6 ? (ip.split("%")[0] ?? ip) : ip;
  const type = family === 6 ? "ipv6" : "ipv4";
  if (never.check(address, type)) return { allowed: false, reason: "a reserved or link-local address" };
  if (edition === "cloud" && internal.check(address, type)) return { allowed: false, reason: "a private address" };
  return { allowed: true };
}

export class NetworkRefused extends Error {
  override name = "NetworkRefused";
}

/**
 * Resolves the host and returns every address this edition may connect to, in the resolver's order. Callers try them
 * in turn ("localhost" is often ::1 first while the server only listens on 127.0.0.1).
 */
export async function vetHost(host: string, edition: Edition): Promise<string[]> {
  const answers = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  const allowed: string[] = [];
  let reason = "no addresses";
  for (const { address } of answers) {
    const verdict = addressAllowed(address, edition);
    if (verdict.allowed) allowed.push(address);
    else reason = verdict.reason;
  }
  if (!allowed.length) throw new NetworkRefused(`${host} resolves to ${reason}, which OpenDash doesn't connect to`);
  return allowed;
}

/** Opens (and closes) a TCP connection to an address, returning how long it took. */
export function tcpReach(address: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = new Socket();
    const done = (error?: Error) => {
      socket.destroy();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(Math.round(performance.now() - started));
    };
    const onAbort = () => done(Object.assign(new Error("aborted"), { code: "ABORTED" }));
    // Aborted already (while the host resolved, or before): never dial.
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(timeoutMs, () => done(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    socket.once("error", (error) => done(error));
    socket.connect(port, address, () => done());
  });
}

/** Resolves and vets the host, then returns the first allowed address that accepts a TCP connection. */
export async function reach(
  config: { host: string; port: number },
  edition: Edition,
  connectTimeoutMs: number,
  signal?: AbortSignal,
): Promise<{ address: string; latencyMs: number }> {
  let lastError: unknown;
  for (const candidate of await vetHost(config.host, edition)) {
    try {
      return { address: candidate, latencyMs: await tcpReach(candidate, config.port, connectTimeoutMs, signal) };
    } catch (error) {
      // Stopped: no other address is tried.
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
