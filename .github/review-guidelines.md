# Review guidelines for the Bynk playground

These are the maintainers' notes for reviewing a pull request here. The
playground is a static, client-side app where anyone can write, compile and
run Bynk in the browser: the compiler runs as wasm, and the compiled
JavaScript runs in a sandbox (ADR 0140, in bynk-lang/bynk). It also has a
small share service, `share/`, written in Bynk. Often a visitor's first sight
of Bynk, it runs code anyone can paste or link, so a change is judged for
safety first, then for what it shows a newcomer.

Skip what CI already enforces: the type check, `npm test` (every gallery
example and tour step through the staged compiler, and the unit tests), the
browser tests in `test/e2e`, the bundle, `npm audit`, `bynk-ci` on `share/`,
and the Workers' dry-run deploy.

## What matters most

- **Two origins, always.** Untrusted code runs only on the sandbox origin
  (`sandbox.bynk-lang.dev`), never on the app origin. The app Worker refuses
  the sandbox's files, and the sandbox Worker serves only the execution
  document. Flag any change that lets snippet code run on, or reach, the app
  origin: serving `sandbox.html` or `sandbox.js` from the app, loosening the
  iframe's `sandbox` attribute beyond `allow-scripts`, or sharing storage
  between the two. This is blocking whatever the reason.
- **Messages between the two.** The app recognises the sandbox's iframe by its
  window, answers only its first ready message, and talks over a
  `MessageChannel`. The sandbox accepts that port only from the app origin.
  Both check a message's `kind` and shape before using it. Flag a new
  listener or message kind that skips these checks, or trusts what a run
  returns.
- **Running code safely.** Each run happens in a Web Worker, under the
  wall-clock limit, and a superseded run is stopped. Flag a change that can
  let a run outlive its limit, block the page, or keep running after a new
  one starts.
- **The Content-Security-Policy** in `_headers` (written by `build.mjs`) and
  the iframe's attributes are part of the boundary. A change that widens them
  needs a reason in the pull request.
- **Shared links are untrusted.** A `#…` link, a `?s=` snippet and `?args=`
  values can come from anyone. They're decoded defensively, a snippet only
  ever runs in the sandbox, including an embed's run, and an embed never
  touches the visitor's own draft, recents or tour progress.
- **The share service** (`share/`) bounds what it stores (the `Source`
  refined type), keeps snippets for 30 days, and is reached same-origin under
  `/api/`. The app falls back to a `#…` link when it's unavailable, so a
  change mustn't make Share depend on it.
- **Browser storage** (`src/store.ts`) is guarded on every access, so the
  playground still works where storage is blocked or full.

## The pinned compiler

- `BYNK_VERSION` is moved by the org canary's pull request, once the
  playground passes at the new release. A hand-edited pin needs a reason. A
  release's browser artefacts are installed by `scripts/fetch-assets.sh`, which
  checks them against the release's `SHA256SUMS`. Flag a change that skips the
  check or fetches the compiler from anywhere else.
- `WRANGLER_VERSION` is the one Wrangler pin, shared by CI and the Workers
  tests.

## What a newcomer sees

- **Examples and the tour** (`src/examples.ts`, `src/tour.ts`) are teaching
  material. Each example should run, show one idea, and be in the house style
  (`bynk fmt`'s output, which `test/style.test.mjs` checks). Each tour step's
  starter must fail its check and its solution pass. Flag an example that
  teaches a pattern the Book advises against.
- **Messages a visitor reads**, such as diagnostics' "Try:" hints, the limit
  messages and "What runs here", should say what to do next in plain words.
- **Accessibility and layout.** Controls work from the keyboard and have
  labels; the phone layout and the theme keep working.

## Tests

- A change of behaviour comes with a test at the right level: a unit test in
  `test/`, a browser test in `test/e2e/` for a flow a visitor follows, or a
  test in `share/tests/` for the share service.
- Look for missing cases: a snippet that never ends, one that throws, a
  malformed shared link, an unavailable share service, and blocked storage.

## Style

- British English in comments, the README and every string a visitor sees
  ("behaviour", "colour", "licence" as a noun).
- Comments explain why, in plain sentences, and name the issue or decision
  behind them.
- The README's Layout table gains a row for a new file, and stays in step
  with what each file does.

## Severity here

- **Blocking:** anything that weakens the two-origin boundary, the message
  checks or the time limit; a shared link that can run code or reach the
  visitor's data; a compiler fetched unverified; or a gallery example or tour
  step that no longer works.
- **Should fix:** a missing test for changed behaviour, a widened CSP without
  a reason, unguarded storage, Share depending on the share service, an
  unhelpful message to a visitor, or the README out of step.
- **Nit:** wording, naming and small style points. Keep these few.
