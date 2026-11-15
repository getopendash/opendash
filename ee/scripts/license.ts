/**
 * The licensor's tool. It runs on the licensor's machine, never on an instance, and the private key it makes never
 * enters this repository.
 *
 *   pnpm license:keygen --out ~/opendash-licensor.pem
 *     makes the licensor's Ed25519 key pair: the private key goes to --out (readable by its owner only, never
 *     overwritten), and the line to add to ee/src/license/keys.ts is printed.
 *
 *   pnpm license:issue --key ~/opendash-licensor.pem --licensee "Acme Inc." --features sso,scim,audit \
 *     --expires 2027-12-31 [--seats 150] [--instance https://opendash.acme.com]
 *     prints a license key, the value of OPENDASH_LICENSE_KEY. A date alone expires at the end of that day (UTC).
 *
 *   pnpm license:issue --key ~/opendash-licensor.pem --service --licensee "OpenDash Cloud"
 *     prints the service key for the licensor's own service: every feature, no expiry, no address. Set it only there.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ENTERPRISE_FEATURES, type EnterpriseFeature } from "@opendash/core/enterprise";
import { ISSUER_KEYS } from "../src/license/keys";
import { encodePublicKey, issueLicense, issueServiceKey, keyId } from "../src/license/license";

const repository = path.resolve(import.meta.dirname, "../..");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** pnpm runs this from ee/, so a path is read from where the command was typed, and never inside the repository. */
function outsideRepository(value: string | undefined, flag: string): string {
  if (!value) fail(`--${flag} is required.`);
  const resolved = path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
  const inside = path.relative(repository, resolved);
  if (!inside.startsWith("..") && !path.isAbsolute(inside)) {
    fail(`Keep the licensor's key outside the repository (${resolved} is inside it).`);
  }
  return resolved;
}

const [command, ...args] = process.argv.slice(2);

if (command === "keygen") {
  const { values } = parseArgs({ args, options: { out: { type: "string" } } });
  const out = outsideRepository(values.out, "out");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  try {
    writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      fail(`${out} exists. A licensor's key is never overwritten.`);
    throw error;
  }
  console.log(`The private key is in ${out}. Keep it safe: whoever has it can issue licenses.`);
  console.log("Add this line to ISSUER_KEYS in ee/src/license/keys.ts:");
  console.log(`  "${keyId(publicKey)}": "${encodePublicKey(publicKey)}",`);
} else if (command === "issue") {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: "string" },
      licensee: { type: "string" },
      features: { type: "string" },
      expires: { type: "string" },
      seats: { type: "string" },
      instance: { type: "string" },
      service: { type: "boolean" },
    },
  });
  const privateKey = createPrivateKey(readFileSync(outsideRepository(values.key, "key")));
  if (!values.licensee) fail("--licensee is required.");
  const kid = keyId(createPublicKey(privateKey));
  if (!ISSUER_KEYS[kid]) {
    console.error(
      `Note: key ${kid} isn't in ee/src/license/keys.ts yet, so no instance accepts this license until it is.`,
    );
  }
  if (values.service) {
    if (values.features || values.expires || values.seats || values.instance) {
      fail("A service key covers every feature, with no expiry, seats or instance: give only --licensee.");
    }
    console.log(issueServiceKey(values.licensee, privateKey));
    process.exit(0);
  }
  const features = (values.features ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const unknown = features.filter((f) => !(ENTERPRISE_FEATURES as readonly string[]).includes(f));
  if (!features.length || unknown.length) {
    fail(
      `--features takes some of: ${ENTERPRISE_FEATURES.join(", ")}.${unknown.length ? ` Unknown: ${unknown.join(", ")}.` : ""}`,
    );
  }
  if (!values.expires) fail("--expires is required (a date, 2027-12-31, or a time).");
  const expires = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(values.expires) ? `${values.expires}T23:59:59.999Z` : values.expires,
  );
  const seats = values.seats === undefined ? undefined : Number(values.seats);
  if (seats !== undefined && !(Number.isInteger(seats) && seats > 0)) fail("--seats is a whole number above 0.");
  console.log(
    issueLicense(
      {
        licensee: values.licensee,
        features: features as EnterpriseFeature[],
        expires,
        ...(seats ? { seats } : {}),
        ...(values.instance ? { instance: values.instance } : {}),
      },
      privateKey,
    ),
  );
} else {
  fail(
    "Usage: license:keygen --out <file> | license:issue --key <file> --licensee <name> (--features <list> --expires <date> | --service)",
  );
}
