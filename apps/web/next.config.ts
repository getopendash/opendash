import path from "node:path";
import type { NextConfig } from "next";
import { loadRootEnv } from "../../scripts/load-env.mjs";

const root = path.join(import.meta.dirname, "../..");

// One set of env files at the repo root for every app (Next.js only reads them from the app directory).
loadRootEnv(root);

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  transpilePackages: [
    "@opendash/api",
    "@opendash/apps",
    "@opendash/ui",
    "@opendash/auth",
    "@opendash/charts",
    "@opendash/db",
    "@opendash/core",
    "@opendash/ee",
    "@opendash/markdown",
    "@opendash/connectors",
    "@opendash/pdf",
    "@opendash/slack",
    "@opendash/tokens",
  ],
  poweredByHeader: false,
  // Loaded by Node at runtime, not bundled: libpg-query ships a .wasm file next to its JS (the web app never runs
  // queries itself, but @opendash/core includes the gateway); @resvg/resvg-js is a native module (a PDF's charts),
  // its platform's binary a package of its own.
  // unpdf: a PDF reference is read in a process of its own, which loads it by name from the server's folder; as an
  // external package it's traced into the standalone output where that process finds it.
  serverExternalPackages: ["libpg-query", "@resvg/resvg-js", "unpdf"],
  // An answer's PDF embeds Geist: @opendash/pdf's font files go into the server build with its route.
  outputFileTracingIncludes: {
    "/runs/[id]/pdf": ["../../packages/pdf/fonts/*.ttf"],
  },
  async headers() {
    return [
      // Every page and route: no type sniffing, never framed by another site (clickjacking), no camera, microphone or
      // location, and no full URL sent to another site. HTTPS only, once deployed (HSTS is ignored over plain HTTP).
      // Not a dashboard's frame (/app-frame/…), which sets its own policy: only OpenDash's page may show it.
      // A page's content policy names the frames origin, read on each request: proxy.ts sends it. The API's own
      // pages (an OAuth callback's, single sign-on's form) frame nothing, so theirs is fixed here.
      {
        source: "/:path((?!app-frame/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'; frame-src 'none'" }],
      },
    ];
  },
};

export default config;
