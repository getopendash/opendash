/**
 * The licensor's public keys, by id: an instance accepts a license signed by any of them (license.ts). Empty until
 * the licensor runs `pnpm license:keygen`, which prints the line to add here. A key stays as long as the licenses it
 * signed should keep working; adding a new one lets licensing move to a new holder without breaking issued keys.
 */
export const ISSUER_KEYS: Readonly<Record<string, string>> = {
  "5d6915f74538eba4": "MCowBQYDK2VwAyEAf/mjKNo2c/htPgIrlGhuOLae+XZpmls4b8uC3/5VbPc=",
};
