/**
 * OpenDash's side of an MCP server's OAuth, as the official client asks for it. One provider is made for
 * one sign-in or one call and holds what it needs in memory, loaded in a short transaction before any request is made,
 * so no transaction is ever held across a request.
 *
 * In a call (`mode: "call"`) the provider only hands the client its access token. When the server refuses it, the
 * client would refresh or start a sign-in on its own; instead the provider throws NeedsRefresh at the first step, and
 * the executor refreshes the connection itself, one refresh at a time per connection (a refresh token that rotates
 * works once), then tries the call again. Anything that would need a person to sign in throws NeedsSignIn.
 */
import { randomBytes } from "node:crypto";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** What a connection's secret holds: its tokens, the client registration they were issued to, and when they expire. */
export interface ConnectionCredentials {
  tokens: StoredOAuthTokens;
  client: StoredOAuthClientInformation;
  /** When the access token expires (ms since the epoch), when the server said. */
  expiresAt?: number | null;
}

export const credentialsOf = (
  tokens: StoredOAuthTokens,
  client: StoredOAuthClientInformation,
  now = Date.now(),
): ConnectionCredentials => ({
  tokens,
  client,
  expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : null,
});

/** What a sign-in in flight keeps secret: the PKCE verifier, and the client registration it started with. */
export interface FlowSecret {
  codeVerifier: string;
  client: StoredOAuthClientInformation;
}

/** A call would need the person to sign in again (or OpenDash to register again), which only a sign-in can do. */
export class NeedsSignIn extends Error {
  override name = "NeedsSignIn";
}

/** The authorization server turned down the client an admin entered; OpenDash doesn't register one in its place. */
export class ClientRefused extends Error {
  override name = "ClientRefused";
}

/** The server now names another authorization server than the one an admin's client was made at. */
export class IssuerMoved extends Error {
  override name = "IssuerMoved";
  constructor(readonly found: string) {
    super("The server signs in somewhere else now");
  }
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** The server refused the access token in a call: the executor refreshes the connection and tries once more. */
export class NeedsRefresh extends Error {
  override name = "NeedsRefresh";
}

export interface ProviderOptions {
  mode: "connect" | "call";
  redirectUrl: string;
  /** The name the authorization server shows people when they're asked to allow OpenDash. */
  clientName: string;
  scopes?: string | null;
  /** The `state` sent with a sign-in (connect only). */
  state?: string;
  client?: StoredOAuthClientInformation;
  /**
   * False when the client is one an admin entered: OpenDash never registers a client of its own in its place, so a
   * client the authorization server turns down is said, not quietly replaced.
   */
  registration?: boolean;
  /** OpenDash's client metadata document (https), for authorization servers that take one as the client ID. */
  clientMetadataUrl?: string;
  /**
   * The authorization server a client an admin entered was made at. A sign-in that discovers any other one stops before
   * anything is sent to it, so the client's secret only ever goes where it belongs.
   */
  expectedIssuer?: string | null;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState | null;
}

export class OpenDashOAuthProvider implements OAuthClientProvider {
  /** Where a sign-in sends the person, once `auth` has answered REDIRECT. */
  authorizationUrl: URL | undefined;
  /** A client registration made during this sign-in (dynamic registration). */
  registeredClient: StoredOAuthClientInformation | undefined;
  savedTokens: StoredOAuthTokens | undefined;
  savedVerifier: string | undefined;
  savedDiscovery: OAuthDiscoveryState | undefined;
  /** The given client, stamped with the issuer it was first used with (the client library binds it). */
  private stampedClient: StoredOAuthClientInformation | undefined;
  private readonly invalidated = new Set<string>();

  constructor(private readonly options: ProviderOptions) {}

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadataUrl(): string | undefined {
    return this.options.registration === false ? undefined : this.options.clientMetadataUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: PKCE protects the code, and there's no client secret to keep per server.
      token_endpoint_auth_method: "none",
      ...(this.options.scopes ? { scope: this.options.scopes } : {}),
    };
  }

  saveAuthorizationServerUrl(issuer: string): void {
    // Called right after discovery, before any client information or token request.
    const expected = this.options.expectedIssuer;
    if (expected && !sameIssuer(issuer, expected)) throw new IssuerMoved(issuer);
    // A client an admin entered goes nowhere it isn't bound to: without a binding, nowhere at all.
    if (!expected && this.options.registration === false) throw new IssuerMoved(issuer);
  }

  state(): string {
    // A call never reaches a sign-in (redirectToAuthorization throws first), but the client asks for state before.
    return this.options.state ?? randomBytes(32).toString("base64url");
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    if (this.invalidated.has("client")) {
      if (this.options.registration === false) throw new ClientRefused("The authorization server refused that client");
      return undefined;
    }
    return this.client;
  }

  /** The client this sign-in uses: one registered during it, or the given one (stamped with its issuer). */
  get client(): StoredOAuthClientInformation | undefined {
    return this.registeredClient ?? this.stampedClient ?? this.options.client;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    if (this.options.mode === "call") throw new NeedsSignIn("OpenDash would have to register with this server again");
    if (this.options.client && info.client_id === this.options.client.client_id) {
      this.stampedClient = info;
      return;
    }
    if (this.options.registration === false) throw new ClientRefused("The authorization server refused that client");
    this.registeredClient = info;
  }

  tokens(ctx?: unknown): StoredOAuthTokens | undefined {
    // With a context, the client is inside its own sign-in or refresh: a call leaves that to the executor.
    if (ctx !== undefined && this.options.mode === "call") throw new NeedsRefresh("The server refused the token");
    if (this.invalidated.has("tokens")) return undefined;
    return this.savedTokens ?? this.options.tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    if (this.options.mode === "call") throw new NeedsRefresh("The server refused the token");
    this.savedTokens = tokens;
    this.invalidated.delete("tokens");
  }

  redirectToAuthorization(url: URL): void {
    if (this.options.mode === "call") throw new NeedsSignIn("This account has to be signed in again");
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.savedVerifier = verifier;
  }

  codeVerifier(): string {
    const verifier = this.options.codeVerifier ?? this.savedVerifier;
    if (!verifier) throw new NeedsSignIn("This sign-in has no verifier");
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.savedDiscovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    // The first thing the client asks for when it starts its own sign-in or refresh, before any request.
    if (this.options.mode === "call") throw new NeedsRefresh("The server refused the token");
    if (this.invalidated.has("discovery")) return undefined;
    return this.savedDiscovery ?? this.options.discovery ?? undefined;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    // A call can't register again; a refused refresh comes back as NeedsSignIn from the sign-in it falls back to.
    if (this.options.mode === "call" && (scope === "all" || scope === "client")) {
      throw new NeedsSignIn("This server no longer accepts OpenDash's registration");
    }
    if (scope === "all") for (const s of ["client", "tokens", "verifier", "discovery"]) this.invalidated.add(s);
    else this.invalidated.add(scope);
  }
}

/** The issuer a token set or a discovery belongs to. */
export function issuerOf(discovery: OAuthDiscoveryState | null | undefined): string | null {
  if (!discovery) return null;
  return discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl ?? null;
}

/**
 * Who a token set belongs to, when the authorization server says: the `sub` (and an email or name to show) of an ID
 * token that came back with it. It came straight from the token endpoint over the guarded connection, which OpenID
 * Connect allows in place of checking its signature (Core §3.1.3.7), and it's only compared, never trusted for access.
 * Most MCP servers send none, and then a reconnect as another account can't be told apart.
 */
export function accountOf(tokens: StoredOAuthTokens): { key: string | null; label: string | null } {
  const idToken = (tokens as { id_token?: unknown }).id_token;
  if (typeof idToken !== "string") return { key: null, label: null };
  const payload = idToken.split(".")[1];
  if (!payload) return { key: null, label: null };
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 320 ? v : null);
    return { key: text(claims.sub), label: text(claims.email) ?? text(claims.name) };
  } catch {
    return { key: null, label: null };
  }
}
