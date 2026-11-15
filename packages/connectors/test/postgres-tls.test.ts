// Postgres's TLS against a stand-in server on loopback (no database): it takes the client's SSLRequest, says yes,
// answers TLS with a certificate a test CA signed, and refuses the sign-in once the client's startup message arrives.
// OpenDash connects to the vetted address, never the name typed, so with verify-full the certificate must still name
// that host (or that IP, which postgres.js leaves TLS no way to know); require accepts any certificate.
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSession, type PostgresConfig } from "../src/postgres/session";
import {
  type CertificateName,
  hasOpenssl,
  startTls,
  type TestCertificates,
  testCertificates,
} from "./helpers/tls-stand-in";

/** A FATAL ErrorResponse, 28P01: what the server says to a sign-in it refuses. */
function refused(): Buffer {
  const fields = Buffer.from("SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed\0\0", "latin1");
  const head = Buffer.alloc(5);
  head.write("E", 0, "latin1");
  head.writeUInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

let certs: TestCertificates;
let server: Server;
let port = 0;
/** Which certificate the stand-in answers TLS with, and how many startup messages (sign-ins) reached it. */
const stand: { cert: CertificateName; startups: number } = { cert: "warehouse", startups: 0 };

function serve(socket: Socket) {
  // The SSLRequest is 8 bytes; "S" says TLS follows.
  startTls(
    socket,
    { requestBytes: 8, reply: Buffer.from("S"), key: certs.key(stand.cert), cert: certs.cert(stand.cert) },
    (secure) => {
      stand.startups += 1;
      secure.end(refused());
    },
  );
}

beforeAll(async () => {
  if (!hasOpenssl) return;
  certs = testCertificates();
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  if (!hasOpenssl) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  certs.remove();
});

const options = { connectTimeoutMs: 5_000, statementTimeoutMs: 5_000, applicationName: "opendash-test" };
const config = (over: Partial<PostgresConfig>): PostgresConfig => ({
  host: "warehouse.test",
  port,
  database: "app",
  user: "reader",
  sslMode: "verify-full",
  ca: certs.ca,
  ...over,
});

/** How a sign-in to the stand-in ends: refused by the server (TLS was accepted), or TLS refused by the client. */
async function signIn(c: PostgresConfig, cert: CertificateName) {
  stand.cert = cert;
  stand.startups = 0;
  const { sql, close } = openSession(c, "127.0.0.1", "secret", options);
  const error = await sql`select 1`.then(
    () => null,
    (e: { code?: string; message?: string }) => e,
  );
  await close();
  const tls = /altnames|certificate|verify/i.test(error?.message ?? "") && error?.code !== "28P01";
  return {
    code: tls ? (/altnames/.test(error?.message ?? "") ? "wrong name" : "unverified") : error?.code,
    signedIn: stand.startups > 0,
  };
}

describe.skipIf(!hasOpenssl)("Postgres TLS", () => {
  it("verify-full: a certificate for the name typed signs in; one for another name never gets that far", async () => {
    expect(await signIn(config({}), "warehouse")).toEqual({ code: "28P01", signedIn: true });
    expect(await signIn(config({}), "other")).toEqual({ code: "wrong name", signedIn: false });
  });

  it("verify-full by IP: the certificate must name that IP, not localhost", async () => {
    const byIp = config({ host: "127.0.0.1" });
    expect(await signIn(byIp, "loopback")).toEqual({ code: "28P01", signedIn: true });
    expect(await signIn(byIp, "warehouse")).toEqual({ code: "wrong name", signedIn: false });
  });

  it("verify-full without the CA trusts only the public ones; require accepts any certificate", async () => {
    expect(await signIn(config({ ca: undefined }), "warehouse")).toEqual({ code: "unverified", signedIn: false });
    expect(await signIn(config({ sslMode: "require", ca: undefined }), "other")).toEqual({
      code: "28P01",
      signedIn: true,
    });
  });
});
