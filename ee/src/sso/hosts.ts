/**
 * Identity providers are reached from the server, so their addresses get the rules sources get: a provider a workspace
 * sets up must be on the public internet. Better Auth checks the OIDC endpoints it calls, except at origins it's told
 * to trust, and ours (the verified issuers) are told to; so the issuer's host is resolved and checked here, at
 * registration and before each sign-in. An origin the operator lists in OPENDASH_SSO_TRUSTED_IDP_ORIGINS (an identity
 * provider on the deployment's own network) is the exception.
 */
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { NetworkRefused, vetHost } from "@opendash/connectors/network";
import { BUDGETS } from "@opendash/core";
import { trustedIdpOrigins } from "./policy";

export class IdpAddressRefused extends Error {
  override name = "IdpAddressRefused";
}

/** https, and resolving only to public addresses, unless the operator trusts the origin. */
export async function assertPublicIdpUrl(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IdpAddressRefused("isn't a URL");
  }
  if (url.username || url.password) throw new IdpAddressRefused("mustn't carry a user name or password");
  if (trustedIdpOrigins().includes(url.origin)) return;
  if (url.protocol !== "https:") throw new IdpAddressRefused("must start with https://");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      vetHost(url.hostname, "cloud"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new IdpAddressRefused("didn't resolve in time")), BUDGETS.sso.lookupMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof IdpAddressRefused) throw error;
    if (error instanceof NetworkRefused) throw new IdpAddressRefused("resolves to a private address");
    throw new IdpAddressRefused("didn't resolve");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A SAML provider's metadata, read once at registration: https only, connecting only to the addresses the check above
 * allowed (the host isn't resolved a second time, so DNS can't change between the check and the request), no
 * redirects, and the body read up to `maxBytes` and refused past it.
 */
export async function fetchPublicText(
  value: string,
  options: { signal: AbortSignal; maxBytes: number; accept?: string },
): Promise<string> {
  const url = new URL(value);
  // An origin the operator trusts may be http outside production (trustedIdpOrigins refuses it in production).
  const trusted = trustedIdpOrigins().includes(url.origin);
  if (url.protocol !== "https:" && !(trusted && url.protocol === "http:")) {
    throw new IdpAddressRefused("must start with https://");
  }
  const addresses = trusted ? null : await vetHost(url.hostname, "cloud").catch(() => null);
  if (!trusted && !addresses?.length) throw new IdpAddressRefused("resolves to a private address");
  const pinned: LookupFunction = (_host, opts, done) => {
    const list = (addresses ?? []).map((address) => ({ address, family: isIP(address) }));
    if (opts.all) (done as (e: Error | null, a: { address: string; family: number }[]) => void)(null, list);
    else done(null, list[0]?.address ?? "", list[0]?.family ?? 4);
  };
  return new Promise<string>((resolve, reject) => {
    const req = (url.protocol === "http:" ? http : https).request(
      url,
      {
        method: "GET",
        signal: options.signal,
        headers: { accept: options.accept ?? "*/*" },
        ...(addresses ? { lookup: pinned } : {}),
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 300) {
          res.resume();
          reject(new IdpAddressRefused(`answered ${res.statusCode}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            req.destroy();
            reject(new IdpAddressRefused("sent more than its size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.on("error", (error) => reject(options.signal.aborted ? new IdpAddressRefused("didn't answer in time") : error));
    req.end();
  });
}
