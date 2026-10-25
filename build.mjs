// Build the playground into dist/ with esbuild (in-browser track, slice 4).
//
// Two entry points — the app and the sandbox execution document — bundled as ES
// modules, plus the static assets (HTML, the wasm compiler glue + module). The app
// and sandbox origins are injected via `define`; defaults are the production hosts,
// overridden by BYNK_APP_ORIGIN / BYNK_SANDBOX_ORIGIN for local verification.
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const appOrigin = process.env.BYNK_APP_ORIGIN ?? "https://playground.bynk-lang.dev";
const sandboxOrigin = process.env.BYNK_SANDBOX_ORIGIN ?? "https://sandbox.bynk-lang.dev";

// BYNK_OUT_DIR lets the browser tests build beside the real dist/ (test/e2e).
const OUT = process.env.BYNK_OUT_DIR ?? "dist";

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Content-hashed files (#33): the app bundle, the wasm and the fonts are written to
// static/ under names that change with their content, and `_headers` serves static/ with
// a year-long immutable cache. A returning visitor re-downloads only what a deploy
// changed (the compiler wasm alone is 9 MB); the HTML stays unhashed and is always
// revalidated, so it always points at the current files.
const STATIC = "static";
await mkdir(`${OUT}/${STATIC}`, { recursive: true });

/** Copy `src` to static/ under `name` with a content hash; return its path from the root. */
async function hashed(src, name) {
  const buf = await readFile(src);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 10);
  const dot = name.lastIndexOf(".");
  const out = `${STATIC}/${name.slice(0, dot)}-${hash}${name.slice(dot)}`;
  await writeFile(`${OUT}/${out}`, buf);
  return out;
}

const bynkWasm = await hashed("src/vendor/bynk_wasm_bg.wasm", "bynk_wasm_bg.wasm");
// web-tree-sitter highlighting (slice 5b): the runtime + grammar wasm. Optional: the app
// falls back to the stream highlighter if these are absent (e.g. the grammar wasn't built).
const treeSitter = {};
for (const w of ["tree-sitter.wasm", "tree-sitter-bynk.wasm"]) {
  try {
    treeSitter[w] = await hashed(`src/vendor/${w}`, w);
  } catch {
    treeSitter[w] = w;
    console.warn(`note: src/vendor/${w} missing — run \`npm run fetch:assets\` for web-tree-sitter highlighting`);
  }
}

const define = {
  __APP_ORIGIN__: JSON.stringify(appOrigin),
  __SANDBOX_ORIGIN__: JSON.stringify(sandboxOrigin),
  __BYNK_WASM__: JSON.stringify(bynkWasm),
  __TS_WASM__: JSON.stringify(treeSitter["tree-sitter.wasm"]),
  __TS_BYNK_WASM__: JSON.stringify(treeSitter["tree-sitter-bynk.wasm"]),
};

// web-tree-sitter's wasm glue imports Node built-ins (`fs/promises`, `module`, …) on a
// branch guarded by `ENVIRONMENT_IS_NODE` — never taken in the browser, but esbuild
// must still resolve the imports. Stub them to empty modules for the browser bundle.
const nodeStub = {
  name: "node-builtin-stub",
  setup(build) {
    const filter = /^(node:)?(fs(\/promises)?|path|module|url|crypto|worker_threads)$/;
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "node-stub" }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "export default {}; export const promises = {};",
      loader: "js",
    }));
  },
};
const common = {
  bundle: true,
  outdir: OUT,
  target: "es2022",
  sourcemap: true,
  // Minified unless BYNK_MINIFY=0 (the source maps still map back to src/), so the build
  // the tests drive is the build that ships (#33).
  minify: process.env.BYNK_MINIFY !== "0",
  define,
  // The web-tree-sitter highlight query is bundled as a string.
  loader: { ".scm": "text" },
  plugins: [nodeStub],
};

// The app runs on its own real origin → an ES module loads fine. Content-hashed, like the wasm.
const app = await esbuild.build({
  ...common,
  entryPoints: { app: "src/app.ts" },
  entryNames: `${STATIC}/[name]-[hash]`,
  format: "esm",
  metafile: true,
});
const appJs = Object.keys(app.metafile.outputs)
  .find((f) => f.endsWith(".js"))
  .slice(OUT.length + 1);

// The sandbox runs in a `sandbox="allow-scripts"` iframe with an **opaque ("null")
// origin**. A `type="module"` script there is fetched in CORS mode and a null origin
// can't load it; a **classic IIFE script is exempt** (no-cors), so the opaque-origin
// isolation is kept without serving CORS headers. Dynamic `import()` of the blob-URL
// graph from the (classic) Worker still works (blob: is local, not CORS-gated).
await esbuild.build({ ...common, entryPoints: { sandbox: "src/sandbox.ts" }, format: "iife" });

// The page, pointed at the hashed app bundle and fonts (the self-hosted code font,
// JetBrainsMono Nerd Font, trimmed; see fonts/README.md).
let html = (await readFile("index.html", "utf8")).replace('src="./app.js"', `src="./${appJs}"`);
for (const font of new Set(html.match(/\.\/fonts\/[\w-]+\.woff2/g))) {
  html = html.replaceAll(font, `./${await hashed(font, font.slice("./fonts/".length))}`);
}
await writeFile(`${OUT}/index.html`, html);
await cp("sandbox.html", `${OUT}/sandbox.html`);
// The font's licence travels with it.
await mkdir(`${OUT}/fonts`, { recursive: true });
await cp("fonts/OFL.txt", `${OUT}/fonts/OFL.txt`);
// Icons and the link-preview image (assets/README.md). Unhashed: their URLs are published
// (favicons, the og:image in shared links).
await cp("assets", OUT, { recursive: true, filter: (src) => !src.endsWith("README.md") });
// Workers static assets read this file for response headers; it is not served itself.
await writeFile(`${OUT}/_headers`, `/${STATIC}/*\n  Cache-Control: public, max-age=31536000, immutable\n`);

console.log(`built ${OUT}/  (app=${appOrigin}  sandbox=${sandboxOrigin})`);
