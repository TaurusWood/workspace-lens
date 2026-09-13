/**
 * Packaged WebUI asset resolution (`docs/v0.3-implementation-plan.md` §7).
 *
 * Assets resolve relative to the INSTALLED module location, never
 * `process.cwd()` (HTTP-003): the resolver anchors at the package root
 * computed from this module's own URL. Until the UI build exists (Slice 13)
 * a restrained placeholder status page is served — the Control Runtime stays
 * usable without pretending the WebUI is already there.
 *
 * No arbitrary filesystem exposure: only the package-owned `dist-ui` tree is
 * consulted, requests are normalized and confined to it, and anything else
 * is a bounded 404.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface UiAsset {
  status: 200 | 404;
  contentType: string;
  body: string | ArrayBuffer;
}

export interface UiAssetResolver {
  resolve(requestPath: string): UiAsset;
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkspaceLens</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
    color: inherit; background: canvas;
  }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
  p { margin: 0; color: color-mix(in srgb, currentColor 65%, transparent); }
  code { font: 13px/1.4 ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <h1>WorkspaceLens Control Runtime</h1>
  <p>The local control runtime is running. The WebUI is not part of this
  build yet; the read-only MCP surface and health endpoints are available.</p>
  <p><code>GET /healthz &middot; GET /readyz</code></p>
</main>
</body>
</html>
`;

/** Content types for the bounded asset vocabulary the UI build produces. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createPackagedUiAssetResolver(): UiAssetResolver {
  // dist/control/static-assets.js -> package root -> dist-ui (module-relative,
  // never process.cwd()).
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const uiRoot = path.resolve(moduleDir, "..", "..", "dist-ui");

  return {
    resolve(requestPath: string): UiAsset {
      const pathname = decodeURIComponent(requestPath.split("?")[0] ?? "/");
      if (pathname === "/" || pathname === "/index.html") {
        const index = path.join(uiRoot, "index.html");
        if (fs.existsSync(index)) {
          return { status: 200, contentType: CONTENT_TYPES[".html"]!, body: toArrayBuffer(fs.readFileSync(index)) };
        }
        return { status: 200, contentType: CONTENT_TYPES[".html"]!, body: PLACEHOLDER_HTML };
      }
      // Confine asset requests to <uiRoot>/assets/<name>; no traversal.
      const match = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(pathname);
      if (match !== null) {
        const file = path.join(uiRoot, "assets", match[1]!);
        if (file.startsWith(path.join(uiRoot, "assets")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const contentType = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
          return { status: 200, contentType, body: toArrayBuffer(fs.readFileSync(file)) };
        }
      }
      return { status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "No such asset." } }) };
    },
  };
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}
