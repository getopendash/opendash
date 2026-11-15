#!/usr/bin/env node
// Draws the logo emails show (apps/web/public/email/opendash-logo@2x.png) from the app's own logo
// (packages/ui/src/icons/opendash-logo.tsx), at twice the size emails display it. Emails use the light theme, and the
// logo sits on the email's background, so the PNG carries that background: a client that darkens emails shows a
// light chip, never a dark wordmark on dark. Run again after the logo or the light background changes:
//   pnpm email:logo
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// The PDF package already depends on resvg (a report's charts); borrow it rather than add a dependency.
const { Resvg } = createRequire(path.join(root, "packages/pdf/package.json"))("@resvg/resvg-js");

const logo = readFileSync(path.join(root, "packages/ui/src/icons/opendash-logo.tsx"), "utf8");
const pathData = (name) => {
  const match = logo.match(new RegExp(`const ${name} =\\s*"([^"]+)"`));
  if (!match) throw new Error(`${name} isn't in opendash-logo.tsx any more`);
  return match[1];
};
const tokens = readFileSync(path.join(root, "packages/tokens/src/tokens.generated.ts"), "utf8");
const light = tokens.slice(tokens.indexOf("light: {"), tokens.indexOf("dark: {"));
const color = (name) => {
  const match = light.match(new RegExp(`"${name}":\\s*"(#[0-9a-fA-F]{6})"`));
  if (!match) throw new Error(`the light theme has no ${name}`);
  return match[1];
};

// The same viewBox and colours as <OpenDashLogo>: the mark in the brand's lavender, the wordmark in the text colour.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="16 18 870 158">
<rect x="16" y="18" width="870" height="158" fill="${color("background")}"/>
<path fill="${color("brand")}" d="${pathData("MARK")}"/>
<path fill="${color("foreground")}" d="${pathData("WORDMARK")}"/>
</svg>`;

// Emails show it 22px tall (layout.ts); twice that for sharp screens.
const png = new Resvg(svg, { fitTo: { mode: "height", value: 44 } }).render().asPng();
const out = path.join(root, "apps/web/public/email/opendash-logo@2x.png");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`${path.relative(root, out)}: ${png.length} bytes`);
