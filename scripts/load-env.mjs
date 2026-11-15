// Loads the repo-root env files for every app and script. Precedence: the real environment, then .env.local, then
// .env. Empty values never win, so a blank `OPENDASH_KEK=` copied into .env.local from .env.example can't hide the
// real key in .env. (Node's own loadEnvFile treats an empty value as set.)
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const ENV_FILES = [".env.local", ".env"];

/**
 * @param {string} root the repo root
 * @param {Record<string, string | undefined>} [env] defaults to process.env
 * @returns {string[]} the files that were found
 */
export function loadRootEnv(root, env = process.env) {
  const found = [];
  for (const file of ENV_FILES) {
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    found.push(file);
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (value !== "" && (env[key] === undefined || env[key] === "")) env[key] = value;
    }
  }
  return found;
}
