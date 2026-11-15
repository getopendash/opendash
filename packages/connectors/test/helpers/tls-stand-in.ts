// What the TLS tests share: certificates a test CA signs (made with openssl, so those tests skip without it), and a
// stand-in server's switch from its database's own protocol to TLS.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";

export const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The certificates: "warehouse" names warehouse.test, "other" other.test, "loopback" the IP 127.0.0.1. */
export type CertificateName = "warehouse" | "other" | "loopback";

export interface TestCertificates {
  /** The CA's certificate (PEM), as an admin would paste it. */
  ca: string;
  key: (name: CertificateName) => string;
  cert: (name: CertificateName) => string;
  remove: () => void;
}

/** A test CA, and a server certificate it signs for each name. */
export function testCertificates(): TestCertificates {
  const dir = mkdtempSync(join(tmpdir(), "opendash-tls-"));
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(
    "req",
    "-x509",
    ...key,
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  );
  const sans: Record<CertificateName, string> = {
    warehouse: "DNS:warehouse.test",
    other: "DNS:other.test",
    loopback: "IP:127.0.0.1",
  };
  for (const [file, san] of Object.entries(sans)) {
    writeFileSync(join(dir, `${file}.ext`), `subjectAltName=${san}\n`);
    openssl("req", ...key, "-keyout", `${file}.key`, "-out", `${file}.csr`, "-subj", `/CN=${file}`);
    openssl(
      "x509",
      "-req",
      "-in",
      `${file}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${file}.pem`,
      "-days",
      "2",
      "-extfile",
      `${file}.ext`,
    );
  }
  const pem = (name: string) => readFileSync(join(dir, name), "latin1");
  return {
    ca: pem("ca.pem"),
    key: (name) => pem(`${name}.key`),
    cert: (name) => pem(`${name}.pem`),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Once the client's request for TLS (its first `requestBytes`) has arrived, writes `reply` if the protocol has one and
 * answers TLS with that certificate; `onData` gets each message the client sends over it. The client's TLS hello may
 * come in the same chunk as its request, so TLS runs over a stream fed from here, what came after the request first.
 */
export function startTls(
  socket: Socket,
  options: { requestBytes: number; reply?: Buffer; key: string; cert: string },
  onData: (secure: TLSSocket) => void,
) {
  socket.on("error", () => {});
  let buffered = Buffer.alloc(0);
  const onRequest = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < options.requestBytes) return;
    socket.off("data", onRequest);
    if (options.reply) socket.write(options.reply);
    const raw = new Duplex({
      read() {},
      write(data, _encoding, done) {
        socket.write(data, done);
      },
      final(done) {
        socket.end();
        done();
      },
    });
    raw.push(buffered.subarray(options.requestBytes));
    socket.on("data", (data) => raw.push(data));
    socket.on("end", () => raw.push(null));
    const secure = new TLSSocket(raw, { isServer: true, key: options.key, cert: options.cert });
    secure.on("error", () => socket.destroy());
    secure.on("data", () => onData(secure));
  };
  socket.on("data", onRequest);
}
