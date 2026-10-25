// Local static server for verification (in-browser track, slice 4). Serves dist/
// on two ports so the app (8080) and the sandbox (8081) are genuinely
// cross-origin — exercising the same postMessage boundary as the production
// playground.bynk-lang.dev / sandbox.bynk-lang.dev split.
//
// Build for these origins first:
//   BYNK_APP_ORIGIN=http://localhost:8080 BYNK_SANDBOX_ORIGIN=http://localhost:8081 node build.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

// BYNK_OUT_DIR / BYNK_APP_PORT / BYNK_SANDBOX_PORT let the browser tests run their own
// build on their own ports (test/e2e); the defaults are the documented local ones.
const ROOT = process.env.BYNK_OUT_DIR
  ? new URL(`${process.env.BYNK_OUT_DIR}/`, `file://${process.cwd()}/`).pathname
  : new URL("./dist/", import.meta.url).pathname;
// Same-origin share API (slice 5c): proxy `/api/*` on the app origin to the local
// `wrangler dev` Worker, mirroring the production Cloudflare route
// (`playground.bynk-lang.dev/api/* → the snippets Worker`) so the browser never
// makes a cross-origin call (Bynk's HTTP surface emits no CORS).
const SHARE_WORKER = process.env.BYNK_SHARE_WORKER ?? "http://localhost:8799";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".scm": "text/plain; charset=utf-8",
};

async function proxyToWorker(req, res, url) {
  try {
    const body = ["GET", "HEAD"].includes(req.method ?? "GET")
      ? undefined
      : await new Promise((resolve) => {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks)));
        });
    const upstream = await fetch(SHARE_WORKER + url.pathname + url.search, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(buf);
  } catch {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("share worker unavailable");
  }
}

// The response headers build.mjs writes to dist/_headers for Workers static assets (the
// page's Content-Security-Policy among them), applied the same way here, so the browser
// tests run under the policy that ships: a path line, then indented "Name: value" lines;
// a path ending in * matches by prefix.
const HEADER_RULES = (() => {
  let text = "";
  try {
    text = readFileSync(`${ROOT}_headers`, "utf8");
  } catch {
    return [];
  }
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: {} });
    else {
      const i = line.indexOf(":");
      rules.at(-1).headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
})();
const headersFor = (pathname) =>
  Object.assign(
    {},
    ...HEADER_RULES.filter(({ path }) => (path.endsWith("*") ? pathname.startsWith(path.slice(0, -1)) : pathname === path)).map((r) => r.headers),
  );

// Like the Workers: the app origin never serves the sandbox's files (worker/app.mjs), and
// an extensionless path is served from its `.html` file (`/sandbox` → sandbox.html).
const SANDBOX_ONLY = /^\/sandbox(\.html|\.js|\.js\.map)?$/;

function serve(port, { app = false } = {}) {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return proxyToWorker(req, res, url);
    let path = decodeURIComponent(url.pathname);
    if (app && SANDBOX_ONLY.test(path)) path = "/missing";
    if (path === "/" || path.endsWith("/")) path += "index.html";
    else if (!extname(path)) path += ".html";
    const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...headersFor(url.pathname), "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  }).listen(port, () => console.log(`serving ${ROOT} on http://localhost:${port}`));
}

serve(Number(process.env.BYNK_APP_PORT ?? 8080), { app: true }); // app origin
serve(Number(process.env.BYNK_SANDBOX_PORT ?? 8081)); // sandbox origin
