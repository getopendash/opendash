/**
 * The domain check: the TXT record as the domain's own nameservers have it, not as this machine's resolver remembers
 * it. Whoever checks has just published the record, and a resolver that already answered "no such name" keeps saying so
 * for the zone's negative TTL (often 15 minutes). The zone's nameservers are its source of truth, so this is the
 * stronger check, and it rests on the same trust: reaching them is the ordinary delegation lookup. Every query can be
 * cancelled, and the whole check runs under one deadline.
 */
import { Resolver } from "node:dns/promises";
import { addressAllowed } from "@opendash/connectors/network";
import { BUDGETS } from "@opendash/core";

export interface TxtProbe {
  /** False when the zone's nameservers couldn't be reached and the local resolver answered. */
  authoritative: boolean;
  records: string[];
  /** Records at `<name>.<domain>`, where a DNS provider that appends the zone to what was typed puts them. */
  doubled: string[];
  error?: string;
}

/** What the check asks DNS; tests pass their own. */
export type TxtLookup = (domain: string, name: string, signal: AbortSignal) => Promise<TxtProbe>;

const ABSENT = new Set(["ENODATA", "ENOTFOUND", "ENONAME"]);

function cancelOn(signal: AbortSignal, resolver: Resolver) {
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

/**
 * The zone's nameservers, as a resolver of their own, or null if they can't be reached (the caller then says the
 * local resolver answered). A zone may publish a nameserver at a private address; nothing is asked there.
 */
async function authoritativeResolver(domain: string, signal: AbortSignal): Promise<Resolver | null> {
  const system = new Resolver({ timeout: BUDGETS.sso.dnsQueryMs, tries: 1 });
  const release = cancelOn(signal, system);
  try {
    const nameservers = await system.resolveNs(domain);
    const addresses = (await Promise.all(nameservers.slice(0, 4).map((ns) => system.resolve4(ns).catch(() => []))))
      .flat()
      .filter((address) => addressAllowed(address, "cloud").allowed);
    if (!addresses.length) return null;
    const resolver = new Resolver({ timeout: BUDGETS.sso.dnsQueryMs, tries: 1 });
    resolver.setServers(addresses);
    return resolver;
  } catch {
    return null;
  } finally {
    release();
  }
}

export const probeTxt: TxtLookup = async (domain, name, outer) => {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(BUDGETS.sso.dnsCheckMs)]);
  const authoritative = await authoritativeResolver(domain, signal);
  const resolver = authoritative ?? new Resolver({ timeout: BUDGETS.sso.dnsQueryMs, tries: 1 });
  const release = cancelOn(signal, resolver);
  const lookup = async (host: string) => {
    try {
      return (await resolver.resolveTxt(host)).map((chunks) => chunks.join("").trim());
    } catch (error) {
      if (ABSENT.has((error as { code?: string }).code ?? "")) return [];
      throw error;
    }
  };
  try {
    const records = await lookup(name);
    const doubled = records.length ? [] : await lookup(`${name}.${domain}`).catch(() => []);
    return { authoritative: authoritative !== null, records, doubled };
  } catch (error) {
    const code = signal.aborted ? "timed out" : ((error as { code?: string }).code ?? "lookup failed");
    return { authoritative: authoritative !== null, records: [], doubled: [], error: code };
  } finally {
    release();
  }
};

/** The plugin's convention accepts the bare value or `<label>=<value>`; so does this. */
export const txtCarries = (records: readonly string[], label: string, expected: string) =>
  records.some((r) => r === expected || r === `${label}=${expected}`);

/**
 * What the check found, for someone just told it didn't pass. "Try again later" can't tell "not published yet" from
 * "published under a name your DNS provider changed"; this can, and says who answered.
 */
export function describeProbe(probe: TxtProbe, domain: string, name: string, expected: string): string {
  const label = name.split(".", 1)[0] ?? name;
  if (probe.error) return `The DNS lookup failed (${probe.error}). Try again in a minute.`;
  const who = probe.authoritative ? `${domain}'s own nameservers have` : "Our DNS resolver has";
  if (txtCarries(probe.doubled, label, expected)) {
    return `The record is at ${name}.${domain}, not ${name}: your DNS provider added the domain to what you typed. Its name field should hold just “${label}”.`;
  }
  if (probe.records.length) {
    return `${who} ${probe.records.length === 1 ? "a TXT record" : `${probe.records.length} TXT records`} at that name, but not this value. Check it was copied whole, without quotes.`;
  }
  return `${who} no TXT record at that name yet. If you've just added it, give it a minute; if your DNS provider asks for a name, it should be just “${label}”.`;
}
