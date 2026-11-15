// MySQL's TLS against a stand-in server on loopback (no database): it greets, takes the client's SSL request, answers
// TLS with a certificate a test CA signed, and refuses the sign-in once the client's handshake response arrives. With
// verify-full the certificate must name the host typed (OpenDash connects to the vetted address, not the name), so a
// certificate for another name ends the connection before the password is ever sent; require accepts any.
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mysqlSettings, openSession } from "../src/mysql/session";
import type { PostgresConfig } from "../src/postgres/session";
import {
  type CertificateName,
  hasOpenssl,
  startTls,
  type TestCertificates,
  testCertificates,
} from "./helpers/tls-stand-in";

// CLIENT_LONG_PASSWORD … CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA, with CLIENT_SSL (0x800).
const CAPABILITIES = 0x3aaa0f;

const packet = (seq: number, body: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUIntLE(body.length, 0, 3);
  head[3] = seq;
  return Buffer.concat([head, body]);
};

/** A MySQL 8.4 server's greeting (Protocol::HandshakeV10), as mysql2's own Handshake.toPacket writes it. */
function greeting(): Buffer {
  const version = "8.4.0";
  const body = Buffer.alloc(68 + version.length, 0);
  let o = 0;
  body[o++] = 10;
  o += body.write(version, o, "latin1");
  body[o++] = 0;
  body.writeUInt32LE(7, o);
  o += 4;
  o += Buffer.from("abcdefgh").copy(body, o);
  body[o++] = 0;
  body.writeUInt16LE(CAPABILITIES & 0xffff, o);
  o += 2;
  body[o++] = 45;
  body.writeUInt16LE(2, o);
  o += 2;
  body.writeUInt16LE(CAPABILITIES >>> 16, o);
  o += 2;
  body[o++] = 21;
  o += 10;
  o += Buffer.from("ijklmnopqrst").copy(body, o);
  body[o++] = 0;
  o += body.write("mysql_native_password", o, "latin1");
  body[o++] = 0;
  return packet(0, body.subarray(0, o));
}

/** Access denied (1045, 28000): what the server says once the handshake response, the password in it, arrives. */
const denied = () => {
  const message = Buffer.from("Access denied", "latin1");
  const body = Buffer.alloc(9 + message.length);
  body[0] = 0xff;
  body.writeUInt16LE(1045, 1);
  body.write("#28000", 3, "latin1");
  message.copy(body, 9);
  return packet(3, body);
};

let certs: TestCertificates;
let server: Server;
let port = 0;
/** Which certificate the stand-in answers TLS with, and whether a handshake response (the password) reached it. */
const stand: { cert: CertificateName; responses: number } = { cert: "warehouse", responses: 0 };

function serve(socket: Socket) {
  socket.write(greeting());
  // The SSL request is a 32-byte body; the handshake response after it carries the password.
  startTls(socket, { requestBytes: 36, key: certs.key(stand.cert), cert: certs.cert(stand.cert) }, (secure) => {
    stand.responses += 1;
    secure.end(denied());
  });
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

/**
 * How a sign-in to the stand-in ends: the server's refusal (TLS was accepted, the password sent), or TLS refused by
 * the client (mysql2's HANDSHAKE_SSL_ERROR) with Node's reason.
 */
async function signIn(c: PostgresConfig, cert: CertificateName) {
  stand.cert = cert;
  stand.responses = 0;
  const error = await openSession(c, "127.0.0.1", "secret", options).then(
    () => null,
    (e: { code?: string; message?: string }) => e,
  );
  const refused = error?.code === "HANDSHAKE_SSL_ERROR";
  return {
    code: refused ? (/altnames/.test(error.message ?? "") ? "wrong name" : "unverified") : error?.code,
    passwordSent: stand.responses > 0,
  };
}

describe.skipIf(!hasOpenssl)("MySQL TLS", () => {
  it("connects to the vetted address while knowing the server by the name typed, and checks it with verify-full", () => {
    const s = mysqlSettings(config({}), "127.0.0.1", "secret", options);
    expect(s.host).toBe("warehouse.test");
    expect(s.ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: true, ca: certs.ca });
    expect(mysqlSettings(config({ sslMode: "require" }), "127.0.0.1", "", options).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(mysqlSettings(config({ sslMode: "disable" }), "127.0.0.1", "", options).ssl).toBeUndefined();
  });

  it("verify-full: a certificate for the name typed signs in; one for another name never gets the password", async () => {
    expect(await signIn(config({}), "warehouse")).toEqual({ code: "ER_ACCESS_DENIED_ERROR", passwordSent: true });
    expect(await signIn(config({}), "other")).toEqual({ code: "wrong name", passwordSent: false });
  });

  it("verify-full by IP: the certificate must name that IP", async () => {
    const byIp = config({ host: "127.0.0.1" });
    expect(await signIn(byIp, "loopback")).toEqual({ code: "ER_ACCESS_DENIED_ERROR", passwordSent: true });
    expect(await signIn(byIp, "warehouse")).toEqual({ code: "wrong name", passwordSent: false });
  });

  it("verify-full without the CA trusts only the public ones; require accepts any certificate", async () => {
    expect(await signIn(config({ ca: undefined }), "warehouse")).toEqual({ code: "unverified", passwordSent: false });
    expect(await signIn(config({ sslMode: "require", ca: undefined }), "other")).toEqual({
      code: "ER_ACCESS_DENIED_ERROR",
      passwordSent: true,
    });
  });
});
