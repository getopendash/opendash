import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderModule } from "./token-engine";

// Into @opendash/tokens: email and server-drawn charts read the values without the UI's dependencies.
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tokens/src/tokens.generated.ts");
writeFileSync(target, renderModule());
console.info(`wrote ${path.relative(process.cwd(), target)}`);
