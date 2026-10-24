# Bynk Playground

The in-browser REPL for [Bynk](https://github.com/bynk-lang/bynk) ([ADR 0140](https://github.com/bynk-lang/bynk/blob/main/design/decisions/0140-repl-execution-and-sandbox.md)).
Type Bynk, press **Run**, see it execute — with **no install and no server**: the
compiler runs in the browser as wasm, and the compiled JavaScript runs in a sandbox.

A fully static, client-side app, served from two origins:

- **`playground.bynk-lang.dev`** — the app: the editor + the `bynk_compile` wasm.
- **`sandbox.bynk-lang.dev`** — the execution document: a sandboxed `<iframe>`
  wrapping a Web Worker. Untrusted code runs **only** here (the safety boundary).

The compiler is not built here. The app runs a **pinned Bynk release** (`BYNK_VERSION`):
each release publishes its browser artefacts (the wasm compiler, its glue and types, the
grammar wasm and highlight query) as `bynk-web-<tag>.tar.gz`, and
`scripts/fetch-assets.sh` stages that tarball in `src/vendor/`. The pin moves when the
[Bynk canary](#the-bynk-canary) has checked the playground against a newer release.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | The app: editor (CodeMirror 6), compile, diagnostics, run, deep-link, Share, examples picker. |
| `src/examples.ts` | The examples gallery — curated, **runnable** in-process snippets; the header picker loads them. `test/examples.test.mjs` compiles and runs every one. |
| `src/sandbox.ts` | The execution document: links the JS graph to blob-URL modules, runs it in a Worker under a wall-clock timeout, posts results back. |
| live diagnostics | A CodeMirror linter (in `src/app.ts`) calls `bynk_analyze` (debounced, on-type) → inline squiggles + gutter. Non-bailing — type errors in a context show live, not only on Run. |
| hover + completion | `src/app.ts` calls `bynk_hover` (the inferred type at the cursor) and `bynk_complete` (context-aware candidates). |
| `src/positions.ts` | UTF-16 (CodeMirror) ↔ UTF-8 byte (`bynk-wasm`) offset mapping, applied at every wasm call; unit-tested by `test/positions.test.mjs`. |
| `src/deeplink.ts` | The shared snippet format: `#base64url(deflate-raw(utf8(source)))`. |
| `src/highlight.ts` | CodeMirror Bynk highlighting (stream-based; see *Highlighting* below). |
| `src/shared.ts` | Origin config + the postMessage protocol. |
| `BYNK_VERSION` | The Bynk release the app is built from. |
| `scripts/fetch-assets.sh` | Download a release's `bynk-web-<tag>.tar.gz`, verify it against the release's `SHA256SUMS`, and unpack it into `src/vendor/`. |
| `build.mjs` / `serve.mjs` | esbuild build into `dist/` / a two-port local static server. |
| `wrangler.app.jsonc` / `wrangler.sandbox.jsonc` | The two Workers that serve `dist/`, one per origin. |
| `share/` | The short-link share service, written in Bynk (below). |

## Build

```sh
npm install
npm run fetch:assets      # the release in BYNK_VERSION; or pass a tag: -- v0.403.3
npm test                  # unit tests + every gallery example through the staged compiler
npm run build             # esbuild → dist/  (production origins by default)
```

To try a compiler build before it is released, point `BYNK_RELEASE_BASE_URL` at a
`file://` directory holding a `bynk-web-<tag>.tar.gz` (from bynk-lang/bynk's
`scripts/package-web-assets.sh`) and a `SHA256SUMS`.

## Verify locally

The app and sandbox must be **different origins**. Build for localhost and serve on
two ports:

```sh
BYNK_APP_ORIGIN=http://localhost:8080 BYNK_SANDBOX_ORIGIN=http://localhost:8081 node build.mjs
node serve.mjs        # app → http://localhost:8080 , sandbox → http://localhost:8081
```

Open `http://localhost:8080`, then check:

1. The starter program is shown; **Run** (or ⌘/Ctrl-Enter) logs a line and prints a value.
2. Break the program → an error diagnostic appears with a line:col, and it does not run.
3. A `consumes bynk.cloudflare { … }` program shows *not runnable in-browser* (the platform lock).
4. **Share** puts a link in the address bar — a short `?s=<id>` link from the share service, or a self-contained `#…` link if the service is unavailable; reloading that URL restores the source.
5. An infinite loop (`fn` that never returns) is terminated after the wall-clock budget.

> The compile, the emitted graph running, and the deep-link round-trip are verified in
> Node (`npm test`); the browser DOM/iframe/Worker flow is verified by the steps above.

## CI and deploy

`.github/workflows/ci.yml` runs on every push and pull request:

- **Test** (`test.yml`): stage the pinned release, type-check, `npm test`, bundle.
- **npm audit**: a high or critical advisory fails it.
- **Share service**: `bynk-ci` (format, check, test) on `share/` at the pinned release.
- **Deploy**: after the three above. On `main` it deploys both Workers with
  `wrangler deploy`; anywhere else (and on `main` before the secrets exist) it does a
  `--dry-run` of both, so a broken Worker config fails before it merges.

**Security note — the app and the sandbox MUST be two distinct origins.** The sandbox origin is the safety boundary defined by [ADR 0140](https://github.com/bynk-lang/bynk/blob/main/design/decisions/0140-repl-execution-and-sandbox.md): untrusted snippet code executes only on the opaque sandbox origin and can never reach the app origin's storage. Never collapse them into one Worker or one domain — doing so dissolves the boundary.

### One-time setup (maintainer)

1. Add the repository secrets `CLOUDFLARE_API_TOKEN` (scoped to **Account → Workers Scripts → Edit** and, for the custom domains, **Zone → Workers Routes → Edit** and **Zone → DNS → Edit** on `bynk-lang.dev`) and `CLOUDFLARE_ACCOUNT_ID`.
2. Push to `main`, or run CI by hand (Actions → CI → Run workflow on `main`). The first deploy creates both Workers:
   - `playground` → `playground.bynk-lang.workers.dev`, custom domain `playground.bynk-lang.dev`;
   - `playground-sandbox` → `playground-sandbox.bynk-lang.workers.dev`, custom domain `sandbox.bynk-lang.dev`.

   Wrangler attaches the custom domains (and creates their DNS records) because the `bynk-lang.dev` zone is in the same account.

### Post-deploy verification

Once both origins serve, re-run the checks in "Verify locally" against `https://playground.bynk-lang.dev`. Confirm the sandbox iframe loads from `https://sandbox.bynk-lang.dev` — that is how you know the origin split is real and not just configured.

## The Bynk canary

The playground is enrolled in the bynk-lang org canary ([`canary/README.md`](https://github.com/bynk-lang/.github/blob/main/canary/README.md)) as kind `app`. On every Bynk release (and weekly), `.github/workflows/bynk-canary.yml`:

1. runs `test.yml` at that release: the unit tests, every gallery example through that release's wasm compiler, and the bundle;
2. runs the org's `canary.yml`, which runs `bynk-ci` on `share/` at the same release and opens, updates or closes the `canary` issue here;
3. when both pass and the release is newer than `BYNK_VERSION`, opens a pull request moving the pin (closing any older one), and starts CI on it. Merging it deploys the new compiler.

A manual run: Actions → Bynk canary → Run workflow, with a version or `latest`.

## Share service (`share/`) — written in Bynk

Short share links (`?s=<id>`) are backed by a **Bynk program** (`share/`)
compiled by `bynkc` to a Cloudflare Worker + KV — dogfooding: the playground that
compiles Bynk has a backend *written* in Bynk. `POST /api/snippets` stores the source
under a random id; `GET /api/snippets/:id` returns it. The `Source` refined type
bounds the body, so oversized/empty payloads are rejected at the boundary (`400`).
Stored snippets expire 30 days after creation (`Kv.putTtl`,
[bynk-lang/bynk#398](https://github.com/bynk-lang/bynk/issues/398)) — a share link is
for showing someone a program, not permanent hosting, so retention is bounded rather
than unbounded KV storage/cost.

The browser calls it **same-origin** (`/api/*` on the app origin) — Bynk's `from http`
emits no CORS headers, so cross-origin would not work; same-origin routing avoids CORS
entirely. If the service is unavailable, Share falls back to the self-contained
`#hash` link, so the playground works without it.

Build + run + verify locally:

```sh
# Compile the Bynk service to a JS Worker:
bynkc compile share --target workers --platform cloudflare --emit js -o /tmp/share-js
# Run it (set wrangler.toml main=index.js + a dummy local KV id):
cd /tmp/share-js/workers/snippets && npx wrangler@4 dev --port 8799 --local
# serve.mjs proxies /api/* → http://localhost:8799 (override with BYNK_SHARE_WORKER),
# so the app at :8080 reaches it same-origin.
curl -X POST :8080/api/snippets -d '{"source":"context x.y\n"}'   # → {"id":"…"}
```

**Not deployed yet.** CI checks the service but does not deploy it. Deploying it means
`wrangler deploy` with a real KV namespace bound as `KV`, plus a route sending
`playground.bynk-lang.dev/api/*` to it ahead of the app Worker's custom domain.

## Highlighting

Highlighting is **web-tree-sitter**: the `tree-sitter-bynk` grammar wasm from the
release tarball, parsed and queried (`highlights.scm`, also from the tarball) in
`src/tshighlight.ts`, with captures rendered as CodeMirror decorations — the same
grammar the editor and CLI use. The runtime `tree-sitter.wasm` comes from this app's
`web-tree-sitter` dependency.

The editor starts on the lightweight CodeMirror **stream highlighter**
(`src/highlight.ts`) and **swaps to web-tree-sitter once its wasm loads** (via a
Compartment). If the grammar wasm is absent or fails to load, the stream highlighter
stays.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.
