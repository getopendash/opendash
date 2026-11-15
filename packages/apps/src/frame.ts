/**
 * The frame document: the same tiny page for every App, served from the frames origin (never OpenDash's own), with a
 * policy that leaves it no network. It has no inline script, so the policy needs no hash or nonce: the runtime and the
 * App's bundle load from immutable, hash-named paths the policy names. The policy is sent as a header and repeated in
 * a meta tag, which the App's code can't remove from inside its sandbox. The App to draw comes from the page around it
 * (`ui/dashboard`).
 *
 * Both scripts are `defer`: the browser fetches them side by side (a plain script in the head held the parser, so the
 * App's bundle was asked for only once the runtime had come down: 0.65 s later) and still runs them
 * in the order written, the runtime and its lockdown first, both before DOMContentLoaded, when the runtime tells the
 * page it's loaded.
 */

export const FRAME_PREFIX = "/app-frame";

export interface FrameInput {
  /** Where frames are served from: a separate origin from OpenDash's. */
  framesOrigin: string;
  /** OpenDash's own origin: the only page that may show the frame. */
  hostOrigin: string;
  runtimeHash: string;
  /** The App's bundle's hash; none before its code is built. */
  bundleHash: string | null;
  title: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export const runtimePath = (hash: string) => `${FRAME_PREFIX}/r/${hash}/runtime.js`;
export const bundlePath = (hash: string) => `${FRAME_PREFIX}/b/${hash}/parts.js`;

/** The frame's policy: scripts only from the runtime's and bundles' paths, no network, shown only by OpenDash. */
export function frameCsp(framesOrigin: string, hostOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src ${framesOrigin}${FRAME_PREFIX}/r/ ${framesOrigin}${FRAME_PREFIX}/b/`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${hostOrigin}`,
  ].join("; ");
}

export function frameDocument(input: FrameInput): { html: string; headers: Record<string, string> } {
  const csp = frameCsp(input.framesOrigin, input.hostOrigin);
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp.replace(/; frame-ancestors [^;]+/, ""))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<script defer src="${escapeHtml(input.framesOrigin + runtimePath(input.runtimeHash))}"></script>
</head><body><div id="root"></div>
${
  input.bundleHash
    ? `<script defer src="${escapeHtml(input.framesOrigin + bundlePath(input.bundleHash))}"></script>
`
    : ""
}</body></html>
`;
  return {
    html,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-dns-prefetch-control": "off",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=(), display-capture=()",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  };
}

/** Headers for the runtime and bundles: immutable by hash, scripts only, readable by the frame's opaque origin. */
export const scriptHeaders: Record<string, string> = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "public, max-age=31536000, immutable",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};
