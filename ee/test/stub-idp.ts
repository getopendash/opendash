// A stub OpenID Connect identity provider served from the test process: just enough of the protocol for the SSO
// plugin's real callback to finish. The token endpoint returns an ID token signed with an RSA key whose public half
// the JWKS endpoint serves, so the plugin's signature, issuer and audience checks all run. Whoever the test says is
// signing in (`as`) is who the token names.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubIdentity {
  sub: string;
  email: string;
  name: string;
}

export interface StubIdp {
  origin: string;
  issuer: string;
  clientId: string;
  /** The person the next token names. */
  as(identity: StubIdentity): void;
  /** Requests the stub has answered, by path: the tests check the plugin did talk to it. */
  hits: string[];
  close(): Promise<void>;
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export async function startStubIdp(clientId = "opendash-test-client"): Promise<StubIdp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  let identity: StubIdentity = { sub: "nobody", email: "nobody@example.test", name: "Nobody" };
  const hits: string[] = [];
  let origin = "";

  const idToken = () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = b64url(
      JSON.stringify({
        iss: origin,
        aud: clientId,
        sub: identity.sub,
        email: identity.email,
        name: identity.name,
        iat: now,
        exp: now + 300,
      }),
    );
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(url.pathname);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/token") {
      res.end(
        JSON.stringify({
          access_token: `at-${identity.sub}`,
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken(),
        }),
      );
      return;
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    issuer: origin,
    clientId,
    as: (next) => {
      identity = next;
    },
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The secret the stub's provider is set up with: the tests check it never appears in the clear. */
export const STUB_CLIENT_SECRET = "stub-client-secret-not-for-logs";
