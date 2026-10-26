// The playground's flows in a real browser: the compile → sandbox → result round trip
// across the two origins, the Result/Logs/Compiled JS tabs, the examples gallery, the
// tour and its saved progress, the share sheet and fork bar, draft restore and Recent,
// the theme toggle, and the phone layout. Skipped (with a note) when no Chrome is
// found. Run: `npm run test:e2e` (after `npm run fetch:assets`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { findChrome, launchBrowser, startApp, startFakeShare } from "./harness.mjs";

const chrome = findChrome();
// CI sets REQUIRE_CHROME so a missing browser fails the job instead of skipping the suite.
if (!chrome && process.env.REQUIRE_CHROME) throw new Error("REQUIRE_CHROME is set but no Chrome/Chromium was found");
const skip = chrome ? false : "no Chrome/Chromium found (set CHROME=/path/to/chrome)";

let share, app, browser, page;

before(async () => {
  if (skip) return;
  share = await startFakeShare();
  app = await startApp(share.port);
  browser = await launchBrowser(chrome);
  page = browser.page;
  await page.setViewport(1512, 860);
  // Record every Content-Security-Policy violation, on every page this file loads, where
  // the last test can read them: sessionStorage outlives the navigations in between (#34).
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORD_CSP_VIOLATIONS });
});

const RECORD_CSP_VIOLATIONS = `addEventListener("securitypolicyviolation", (e) => {
  try {
    const seen = JSON.parse(sessionStorage.getItem("csp-violations") || "[]");
    seen.push(e.violatedDirective + " " + e.blockedURI + " on " + location.pathname + location.search);
    sessionStorage.setItem("csp-violations", JSON.stringify(seen));
  } catch {}
});`;

after(async () => {
  // Stop everything even if one teardown step throws, or the process never exits.
  try {
    await browser?.close();
  } finally {
    app?.stop();
    share?.close();
  }
});

const status = () => page.text("#status");
const settled = () =>
  page.waitFor(`/^(ran|run failed|\\d+ errors?|link copied)$/.test(document.getElementById("status").textContent)`, "a finished run");

// Open the app on a clean slate (no saved draft, recents or tour progress).
async function fresh(path = "") {
  share.state.down = false;
  await page.goto(app.url);
  await page.eval("localStorage.clear()");
  await page.goto(app.url + path);
  await settled();
}

const SCRATCH = "// scratch\n";

test("the opening program runs by itself across the sandbox origin", { skip }, async () => {
  await fresh();
  assert.equal(await status(), "ran");
  assert.match(await page.text("#output"), /⇒ Hello from Bynk!/);
  assert.equal(await page.eval(`document.getElementById("sandbox").src.startsWith(location.origin)`), false, "sandbox is on its own origin");
});

test("a program with no capabilities runs: it has no compose.js, and the sandbox must still find its handler", { skip }, async () => {
  // The reported snippet: no `consumes`, no `given`, so the compiler emits no composition root.
  share.store.set("nocap", "context demo.records\n\ntype Point = { x: Int, y: Int }\n\nservice make {\n  on call() -> Effect[Point] {\n    Point { x: 3, y: 4 }\n  }\n}\n");
  await fresh("?s=nocap");
  assert.equal(await status(), "ran");
  const out = await page.text("#output");
  assert.match(out, /⇒ \{"x":3,"y":4\}/);
  assert.doesNotMatch(out, /No zero-argument/);
});

// Badly formatted but valid Bynk, and a source the formatter cannot parse.
const MESSY = "context  demo.fmt\n\ntype  Point={x:Int,y:Int}\n\nservice make {\non call()->Effect[Point]{\nPoint{x:3,y:4}\n}\n}\n";
const UNPARSABLE = "context demo.fmt\n\ntype Point = { x: Int,\n";

test("Format rewrites the source to the house style as one undoable step", { skip }, async () => {
  share.store.set("messy", MESSY);
  await fresh("?s=messy");
  await page.waitFor(`!document.getElementById("format").disabled`, "Format to be enabled");
  assert.match(await page.editor(), /type {2}Point=\{x:Int,y:Int\}/);
  await page.click("#format");
  await page.waitFor(`document.getElementById("status").textContent === "formatted"`, "the formatted status");
  const formatted = await page.editor();
  assert.match(formatted, /type Point = \{/, "spacing fixed");
  assert.match(formatted, /\n\s*x: Int,\n\s*y: Int,\n/, "the record is laid out one field a line");
  assert.doesNotMatch(formatted, /Point=\{x:Int/);

  // Already formatted: nothing changes, and it says so.
  await page.click("#format");
  assert.equal(await page.text("#status"), "already formatted");
  assert.equal(await page.editor(), formatted);

  // One Undo puts the original back (a single transaction).
  await page.eval(`document.querySelector(".cm-content").focus()`);
  await page.key("z", { ctrl: true });
  assert.match(await page.editor(), /type {2}Point=\{x:Int,y:Int\}/, "Undo restores the text before Format");
});

test("Format on source it cannot parse leaves it alone and says where", { skip }, async () => {
  share.store.set("broken", UNPARSABLE);
  await fresh("?s=broken");
  await page.waitFor(`!document.getElementById("format").disabled`, "Format to be enabled");
  const before = await page.editor();
  await page.click("#format");
  await page.waitFor(`document.getElementById("status").textContent === "can't format"`, "the failure status");
  assert.equal(await page.editor(), before, "the source is untouched");
  const row = await page.text(".diag");
  assert.match(row, /Can't format: expected identifier as a record field name/);
  assert.match(row, /bynk\.format/);
});

test("Shift+Alt+F formats from inside the editor", { skip }, async () => {
  share.store.set("messy2", MESSY);
  await fresh("?s=messy2");
  await page.waitFor(`!document.getElementById("format").disabled`, "Format to be enabled");
  await page.eval(`document.querySelector(".cm-content").focus()`);
  await page.key("f", { alt: true, shift: true });
  await page.waitFor(`document.getElementById("status").textContent === "formatted"`, "the formatted status");
  assert.match(await page.editor(), /type Point = \{/);
});

test("the starter program is in the house style: indented with tabs, shown two columns wide", { skip }, async () => {
  await fresh();
  const raw = await page.eval(`[...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\\n")`);
  assert.match(raw, /\n\t/, "a nested line starts with a tab character");
  assert.doesNotMatch(raw, /\n {2}\S/, "and not with spaces");
  assert.equal(await page.eval(`getComputedStyle(document.querySelector(".cm-content")).tabSize`), "2");
});

test("the insertion point is the amber brand-text colour and legible in both themes", { skip }, async () => {
  await fresh();
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => Number(v) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const theme of ["dark", "light"]) {
    await page.eval(`document.documentElement.dataset.theme = "${theme}"`);
    const { caret, panel, brand } = await page.eval(`(() => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--brand-text");
      document.body.append(probe);
      const brand = getComputedStyle(probe).color;
      probe.remove();
      return {
        caret: getComputedStyle(document.querySelector(".cm-content")).caretColor,
        panel: getComputedStyle(document.querySelector(".cm-editor")).backgroundColor,
        brand,
      };
    })()`);
    assert.equal(caret, brand, `${theme}: the caret follows --brand-text, not CodeMirror's default black`);
    assert.ok(ratio(caret, panel) >= 3, `${theme}: caret ${caret} on ${panel} is ${ratio(caret, panel).toFixed(2)}:1`);
  }
});

test("the bento mark sits beside the wordmark and does not rename the page", { skip }, async () => {
  await fresh();
  assert.equal(await page.visible(".wordmark svg.mark"), true);
  assert.equal(await page.eval(`document.querySelector(".wordmark svg.mark").getAttribute("aria-hidden")`), "true", "decorative");
  assert.equal(await page.eval(`document.querySelector(".wordmark").textContent.replace(/\\s+/g, "")`), "Bynk.");
  const [markRight, textLeft] = await page.eval(`(() => {
    const mark = document.querySelector(".wordmark svg.mark").getBoundingClientRect();
    return [mark.right, document.querySelector(".wordmark .word").getBoundingClientRect().left];
  })()`);
  assert.ok(markRight <= textLeft + 1, "the mark is to the left of the text");
  // The full stop belongs to the word: no flex gap between "Bynk" and ".".
  const gap = await page.eval(`(() => {
    const word = document.querySelector(".wordmark .word");
    const dot = word.querySelector(".dot").getBoundingClientRect();
    const range = document.createRange();
    range.setStart(word.firstChild, 0);
    range.setEnd(word.firstChild, 4);
    return dot.left - range.getBoundingClientRect().right;
  })()`);
  assert.ok(gap < 3, `the full stop hugs "Bynk" (gap ${gap}px)`);
});

test("a broken program shows the error and does not run", { skip }, async () => {
  await fresh();
  await page.type("zzz ");
  await page.click("#run");
  await page.waitFor(`/error/.test(document.getElementById("status").textContent)`, "error status");
  assert.match(await page.text("#diag-summary"), /✕ \d+ error/);
  assert.equal(await page.eval(`document.querySelector(".diag")?.tagName`), "BUTTON");
  assert.match(await page.text("#output"), /Fix the \d+ errors? above/);
});

test("the result tabs: Logs counts lines, arrow keys move between tabs", { skip }, async () => {
  await fresh();
  assert.equal(await page.text("#logs-badge"), "1");
  await page.eval(`document.getElementById("tab-result").focus()`);
  await page.key("ArrowRight");
  assert.equal(await page.eval(`document.querySelector("[role=tab][aria-selected=true]").id`), "tab-logs");
  assert.match(await page.text("#output"), /Hello from Bynk!/);
  await page.key("End");
  assert.match(await page.text("#output"), /\/\/ .*\.js/, "Compiled JS lists the emitted files");
  await page.key("Home");
  assert.equal(await page.eval(`document.querySelector("[role=tab][aria-selected=true]").id`), "tab-result");
});

// The runtime's file header in the Compiled JS view: one `runtime.js` up to Bynk 0.404, the
// `__bynk_runtime/*.js` files from 0.405. Matching the `// ` header, not the bare name,
// since the program's own imports mention the path.
const RUNTIME_HEADER = /\/\/ (?:runtime\.js|__bynk_runtime\/)/;

test("Compiled JS leads with the program's own code; the runtime is a click away and stays open", { skip }, async () => {
  await fresh();
  await page.click("#tab-js");
  // innerText, not textContent: a closed <details> keeps its files in the DOM, unrendered.
  const shown = () => page.eval(`document.getElementById("output").innerText`);
  let out = await shown();
  assert.match(out, /\/\/ hello\/world\.js/);
  assert.match(out, /Runtime and bindings · \d+ files, \d+ lines/);
  assert.match(out, /Composition root · 1 file, \d+ lines/);
  assert.doesNotMatch(out, RUNTIME_HEADER, "the runtime is collapsed");
  assert.ok(out.split("\n").length < 40, `about 15 lines by default, got ${out.split("\n").length}`);
  await page.click(`.out-section[data-kind=support] > summary`);
  assert.match(await shown(), RUNTIME_HEADER);
  await page.click("#run");
  await settled();
  assert.match(await shown(), RUNTIME_HEADER, "an opened section stays open across runs");
});

// A `#…` link to `source` (src/deeplink.ts: base64url of deflate-raw).
const hashLink = (source) => `${app.url}#${deflateRawSync(Buffer.from(source)).toString("base64url")}`;

// Runs for far longer than the 3 s budget, so it is still going when a later run starts.
const SLOW = `context demo.slow

consumes bynk { Logger }

service s {
  on call() -> Effect[Int] given Logger {
    let _ <- Logger.info("slow")
    fib(45)
  }
}

fn fib(n: Int) -> Int {
  if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
}
`;

test("a slow run that ends after a later one never replaces the later result", { skip }, async () => {
  await fresh();
  // Via about:blank: from the app URL, a `#…` link alone is only a fragment change.
  await page.goto("about:blank");
  await page.goto(hashLink(SLOW));
  await page.waitFor(`document.getElementById("status").textContent === "running…"`, "the slow run to start");
  await page.click("#examples");
  await page.click("#gallery-grid .card");
  await page.waitFor(`document.getElementById("output").textContent.includes("Hello from Bynk!")`, "the later run's result");
  // Past the slow run's 3 s budget: its timeout must not take over the pane.
  await new Promise((r) => setTimeout(r, 3500));
  assert.match(await page.text("#output"), /⇒ Hello from Bynk!/);
  assert.equal(await status(), "ran");
});

test("a run that times out still shows what it logged first", { skip }, async () => {
  await fresh();
  await page.goto("about:blank");
  await page.goto(hashLink(SLOW));
  await page.waitFor(`document.getElementById("status").textContent === "run failed"`, "the run to time out", 10000);
  assert.match(await page.text("#output"), /exceeded 3000 ms[\s\S]*logged 1 line first/);
  assert.equal(await page.text("#logs-badge"), "1");
  await page.click("#tab-logs");
  assert.match(await page.text("#output"), /slow/);
});

test("when the code runner can't load, the page says so and can try again", { skip }, async () => {
  // Sandboxed iframes run in their own process, out of reach of this page's network
  // blocking, so simulate the failure itself: the runner's "ready" never reaches the app.
  const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__dropReady = true;
      const add = window.addEventListener;
      window.addEventListener = function (type, fn, opts) {
        if (type !== "message") return add.call(this, type, fn, opts);
        return add.call(this, type, (e) => {
          if (window.__dropReady && e.data && e.data.kind === "bynk-sandbox-ready") return;
          fn(e);
        }, opts);
      };`,
  });
  try {
    await page.goto(app.url);
    await page.eval("localStorage.clear()");
    await page.waitFor(`document.getElementById("status").textContent === "compiler ready"`, "the compiler");
    await page.click("#run");
    assert.match(await page.text("#output"), /still loading/, "Run before the runner is ready says so");
    await page.waitFor(`document.getElementById("status").textContent === "code runner not loaded"`, "the load timeout", 15000);
    assert.match(await page.text("#output"), /hasn't loaded.*blocking it/);
    await page.eval("window.__dropReady = false");
    await page.click("#sandbox-retry");
    await settled();
    assert.match(await page.text("#output"), /⇒ Hello from Bynk!/, "the opening program runs once the runner loads");
  } finally {
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
});

test("the Run button shows the shortcut the platform uses", { skip }, async () => {
  await fresh();
  assert.equal(await page.text("#run-key"), "Ctrl+Enter");
  const { userAgent } = await page.send("Browser.getVersion");
  await page.send("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
  try {
    await page.goto(app.url);
    assert.equal(await page.text("#run-key"), "⌘↵");
  } finally {
    await page.send("Emulation.setUserAgentOverride", { userAgent, platform: "Linux x86_64" });
  }
});


test("the UI font is served from the page's own origin", { skip }, async () => {
  await fresh();
  const status = await page.eval(`(async () => {
    await document.fonts.load('600 14px "Instrument Sans"');
    return [...document.fonts].filter((f) => f.family.includes("Instrument Sans")).map((f) => f.status);
  })()`);
  assert.ok(status.includes("loaded"), `Instrument Sans faces: ${status}`);
  assert.equal(await page.eval(`document.querySelector('link[href*="googleapis"]')`), null);
});


test("a document that takes over the code runner's frame gets no runs and can't answer for them", { skip }, async () => {
  await fresh();
  // What a page framing the playground could do: navigate the inner sandbox frame to a
  // document of its own that answers every message with a made-up result.
  const spoof = `<script>
    onmessage = (e) => parent.postMessage({ kind: "bynk-result", id: e.data && e.data.id, logs: [], value: "spoofed" }, "*");
    parent.postMessage({ kind: "bynk-sandbox-ready" }, "*");
  </script>`;
  await page.eval(`document.getElementById("sandbox").contentWindow.location = ${JSON.stringify(`data:text/html,${encodeURIComponent(spoof)}`)}`);
  await new Promise((r) => setTimeout(r, 1000));
  await page.click("#run");
  await new Promise((r) => setTimeout(r, 1000));
  assert.doesNotMatch(await page.text("#output"), /spoofed/, "a made-up result is never shown");
  assert.equal(await status(), "code runner lost", "the run is not sent to the new document");
  assert.match(await page.text("#output"), /Reload the page/);
  // The page's policy (#34) refuses the navigation itself (frame-src names only the sandbox
  // origin); that refusal is this test's, so take it off the record the last test checks.
  assert.equal(await page.eval(`JSON.parse(sessionStorage.getItem("csp-violations") || "[]").some((v) => v.startsWith("frame-src"))`), true);
  await page.eval(`sessionStorage.setItem("csp-violations", JSON.stringify(JSON.parse(sessionStorage.getItem("csp-violations") || "[]").filter((v) => !v.startsWith("frame-src"))))`);
});


test("Ctrl+Enter runs from outside the editor", { skip }, async () => {
  await fresh();
  await page.eval(`document.getElementById("share").focus(); document.getElementById("output").textContent = ""`);
  await page.key("Enter", { ctrl: true });
  await page.waitFor(`document.getElementById("output").textContent.includes("Hello from Bynk!")`, "output after Ctrl+Enter");
});

test("the examples gallery searches and loads an example", { skip }, async () => {
  await fresh();
  await page.click("#examples");
  assert.equal(await page.eval(`document.activeElement.id`), "gallery-search");
  await page.eval(`(() => { const s = document.getElementById("gallery-search"); s.value = "sum types"; s.dispatchEvent(new Event("input")); })()`);
  assert.equal(await page.eval(`document.querySelectorAll("#gallery-grid .card").length`), 1);
  await page.click("#gallery-grid .card");
  await page.waitFor(`document.getElementById("output").textContent.includes("go")`, "the match example's result");
  assert.match(await page.editor(), /enum \{ Red, Green, Yellow \}/);
  assert.equal(await page.eval(`document.activeElement.id`), "examples", "focus returns to the Examples button");
});

test("the tour: a wrong answer gets a hint, the solution passes, progress is remembered", { skip }, async () => {
  await fresh();
  await page.click("#tour-btn");
  await page.waitFor(`document.getElementById("tour-count").textContent.includes("step 1 of")`, "tour step 1");
  await page.click("#tour-solution");
  await page.click("#tour-check");
  await page.waitFor(`document.getElementById("tour-feedback").dataset.kind === "ok"`, "step 1 passes");
  assert.equal(await page.eval(`document.getElementById("tour-next").disabled`), false);
  assert.equal(await page.text("#tour-btn"), "Tour · 1/9");

  // Step 2 starts failing to compile; Check says so and keeps Next locked.
  await page.click("#tour-next");
  await page.waitFor(`document.getElementById("tour-count").textContent.includes("step 2 of")`, "tour step 2");
  await settled();
  await page.click("#tour-check");
  await page.waitFor(`document.getElementById("tour-feedback").dataset.kind === "miss"`, "a hint");
  assert.equal(await page.eval(`document.getElementById("tour-next").disabled`), true);

  // A fresh visit offers to continue where the learner left off.
  await page.goto(app.url);
  await settled();
  assert.equal(await page.text("#tour-btn"), "Tour · 1/9");
  await page.click("#tour-btn");
  await page.waitFor(`document.getElementById("tour-count").textContent.includes("step 2 of")`, "resume at step 2");
});

test("share: a short link round-trips and the opened snippet offers Fork", { skip }, async () => {
  await fresh();
  await page.type(SCRATCH);
  await page.click("#share");
  await page.waitFor(`document.getElementById("share-url").value.includes("?s=")`, "a short link");
  assert.match(await page.text("#share-note"), /expire after 30 days/);
  const link = await page.eval(`document.getElementById("share-url").value`);
  await page.eval(`document.getElementById("share-sheet").close()`);

  await page.goto(link);
  await settled();
  assert.ok((await page.editor()).includes("// scratch"));
  assert.equal(await page.visible("#shared-note"), true);
  await page.click("#fork");
  assert.equal(await page.visible("#shared-note"), false);
  assert.equal(await page.eval(`location.search`), "", "Fork drops the share URL");
});

test("share: with the service down, the self-contained link is used", { skip }, async () => {
  await fresh();
  share.state.down = true;
  await page.click("#share");
  await page.waitFor(`document.getElementById("share-url").value.includes("#")`, "a hash link");
  assert.match(await page.text("#share-note"), /never expires/);
  const link = await page.eval(`document.getElementById("share-url").value`);
  await page.eval(`document.getElementById("share-sheet").close()`);
  await page.goto("about:blank");
  await page.goto(link);
  await settled();
  assert.equal(await page.visible("#shared-note"), true);
});

test("share: a link to a snippet that has expired says so and drops ?s=", { skip }, async () => {
  await fresh("?s=gone1234");
  assert.equal(await page.visible("#link-note"), true);
  assert.match(await page.text("#link-note"), /expired or doesn't exist.*Showing the starter program/);
  assert.equal(await page.eval(`location.search`), "", "the dead link is dropped");
  assert.match(await page.text("#output"), /⇒ Hello from Bynk!/);
});

test("share: an expired link over a saved draft says the draft is shown, not that it was restored", { skip }, async () => {
  await fresh();
  await page.eval(`localStorage.setItem("bynk-draft", "context my.draft\\n")`);
  await page.goto(`${app.url}?s=gone1234`);
  await settled();
  assert.match(await page.text("#link-note"), /expired or doesn't exist.*Showing your last snippet/);
  assert.equal(await page.visible("#restored-note"), false, "one bar, not two");
  assert.ok((await page.editor()).includes("my.draft"));
});

test("share: with the service down, a short link says so and keeps ?s= for a reload", { skip }, async () => {
  await fresh();
  share.state.down = true;
  await page.goto(`${app.url}?s=t1`);
  await settled();
  assert.match(await page.text("#link-note"), /Couldn't open this share link.*reload/);
  assert.equal(await page.eval(`location.search`), "?s=t1");
  await page.click("#link-dismiss");
  assert.equal(await page.visible("#link-note"), false);
});

test("embed: the share sheet's code loads the same snippet in the compact view", { skip }, async () => {
  await fresh();
  await page.type(SCRATCH);
  await page.click("#share");
  await page.waitFor(`document.getElementById("share-url").value.includes("?s=")`, "a short link");
  const code = await page.eval(`document.getElementById("embed-code").value`);
  assert.match(code, /^<iframe src="http:\/\/localhost:\d+\/\?s=t\d+&amp;embed=1"/);
  assert.match(code, /title="Bynk playground"/);
  const src = code.match(/src="([^"]+)"/)[1].replace(/&amp;/g, "&");
  await page.eval(`document.getElementById("share-sheet").close()`);

  await page.goto(src);
  await settled();
  assert.equal(await page.eval(`document.documentElement.dataset.embed`), "1");
  assert.ok((await page.editor()).includes("// scratch"));
  for (const hidden of ["#share", "#examples", "#tour-btn", "#theme", "#format", "#shared-note"]) {
    assert.equal(await page.visible(hidden), false, `${hidden} is hidden in the embed`);
  }
  assert.equal(await page.visible("#run"), true);
  assert.equal(await page.visible("#open-full"), true);
  const full = await page.eval(`document.getElementById("open-full").href`);
  assert.ok(full.includes("?s=t") && !full.includes("embed"), "Open in playground drops embed");
});

test("embed: never touches the visitor's own draft or recents", { skip }, async () => {
  await fresh("?embed=1");
  await page.type(SCRATCH);
  await page.click("#run");
  await settled();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await page.eval(`localStorage.getItem("bynk-draft")`), null);
  assert.equal(await page.eval(`localStorage.getItem("bynk-recent")`), null);
});

test("the last snippet is restored, Recent lists runs, Start fresh resets", { skip }, async () => {
  await fresh();
  await page.type(SCRATCH);
  await page.click("#run");
  await settled();
  await page.waitFor(`localStorage.getItem("bynk-draft")?.includes("// scratch")`, "the draft to be saved");

  await page.goto(app.url);
  await settled();
  assert.equal(await page.visible("#restored-note"), true);
  assert.ok((await page.editor()).includes("// scratch"));

  await page.click("#examples");
  assert.equal(await page.visible("#recent-section"), true);
  await page.eval(`document.getElementById("gallery").close()`);

  await page.click("#start-fresh");
  await page.waitFor(`!document.querySelector(".cm-content").innerText.includes("// scratch")`, "the default program");
  assert.equal(await page.visible("#restored-note"), false);
});

// Whether a Recent entry's source contains `text` (cards show only a peek of it).
const recentHas = (text) =>
  page.eval(`JSON.parse(localStorage.getItem("bynk-recent") ?? "[]").some((r) => r.src.includes(${JSON.stringify(text)}))`);

test("work that was never run is kept under Recent when an example replaces it", { skip }, async () => {
  await fresh();
  await page.type(SCRATCH);
  await page.click("#examples");
  await page.click("#gallery-grid .card:nth-child(2)");
  await settled();
  assert.ok(!(await page.editor()).includes("// scratch"));

  assert.equal(await recentHas("// scratch"), true, "the replaced work is under Recent");
  await page.click("#examples");
  await page.click("#recent-grid .card");
  await settled();
  assert.ok((await page.editor()).includes("// scratch"));
});

test("exiting the tour puts back what the editor held", { skip }, async () => {
  await fresh();
  await page.type(SCRATCH);
  await page.click("#tour-btn");
  await page.waitFor(`document.getElementById("tour-count").textContent.includes("step 1 of")`, "tour step 1");
  assert.ok(!(await page.editor()).includes("// scratch"));
  await page.click("#tour-exit");
  assert.ok((await page.editor()).includes("// scratch"));
  assert.equal(await page.eval(`location.search`), "", "the ?tour= link is dropped");
  await settled();
  assert.equal(await recentHas("context tour."), false, "the tour's code is not kept");
});

test("opening a shared link keeps the saved draft under Recent", { skip }, async () => {
  await fresh();
  await page.type(SCRATCH);
  await page.click("#share");
  await page.waitFor(`document.getElementById("share-url").value.includes("?s=")`, "a short link");
  const link = await page.eval(`document.getElementById("share-url").value`);
  await page.eval(`document.getElementById("share-sheet").close()`);
  await page.eval(`localStorage.setItem("bynk-draft", "context my.draft\\n")`);

  await page.goto(link);
  await settled();
  assert.equal(await recentHas("my.draft"), true);
});

test("the theme toggle switches and is remembered", { skip }, async () => {
  await fresh();
  const before = await page.eval(`document.documentElement.dataset.theme`);
  await page.click("#theme");
  const after = await page.eval(`document.documentElement.dataset.theme`);
  assert.notEqual(after, before);
  await page.goto(app.url);
  assert.equal(await page.eval(`document.documentElement.dataset.theme`), after);
});

test("on a wide screen Examples, Tour and Theme sit in the toolbar and there is no menu button", { skip }, async () => {
  await fresh();
  assert.equal(await page.visible("#menu-btn"), false);
  for (const id of ["#examples", "#tour-btn", "#format", "#theme"]) assert.equal(await page.visible(id), true, id);
  const x = (id) => page.eval(`document.querySelector("${id}").getBoundingClientRect().left`);
  assert.ok((await x("#examples")) < (await x("#tour-btn")) && (await x("#tour-btn")) < (await x("#run")), "Examples, Tour, then Run");
});

test("on a phone Examples, Tour and Theme fold into a menu button, in one toolbar row", { skip }, async () => {
  await page.setViewport(390, 800);
  try {
    // Loaded from a link, with source that is not in the house style (the starter program is,
    // so Format would have nothing to do), for the Format step at the end.
    share.store.set("messyphone", MESSY);
    await fresh("?s=messyphone");
    assert.equal(await page.visible("#menu-btn"), true);
    for (const id of ["#examples", "#tour-btn", "#format", "#theme"]) assert.equal(await page.visible(id), false, `${id} is hidden until the menu opens`);
    assert.equal(await page.visible("#run"), true);
    assert.equal(await page.visible("#share"), true);
    assert.ok((await page.eval(`document.querySelector("header").getBoundingClientRect().height`)) < 90, "the toolbar stays one row");
    assert.equal(await page.eval(`document.documentElement.scrollWidth > innerWidth`), false);

    // Opening moves focus to the first item; choosing an item acts and closes the menu.
    await page.click("#menu-btn");
    assert.equal(await page.eval(`document.getElementById("menu-btn").getAttribute("aria-expanded")`), "true");
    for (const id of ["#examples", "#tour-btn", "#format", "#theme"]) assert.equal(await page.visible(id), true, id);
    assert.equal(await page.eval(`document.activeElement.id`), "examples");
    await page.click("#examples");
    assert.equal(await page.eval(`document.getElementById("gallery").open`), true);
    assert.equal(await page.visible("#examples"), false, "the menu closed");
    await page.eval(`document.getElementById("gallery").close()`);

    // Escape closes it and returns focus to the button.
    await page.click("#menu-btn");
    await page.key("Escape");
    assert.equal(await page.visible("#examples"), false);
    assert.equal(await page.eval(`document.activeElement.id`), "menu-btn");

    // Theme works from the menu; a click elsewhere closes it.
    const before = await page.eval(`document.documentElement.dataset.theme`);
    await page.click("#menu-btn");
    await page.click("#theme");
    assert.notEqual(await page.eval(`document.documentElement.dataset.theme`), before);
    await page.click("#menu-btn");
    await page.eval(`document.querySelector("main").click()`);
    assert.equal(await page.visible("#theme"), false, "an outside click closes the menu");
    assert.equal(await page.eval(`document.getElementById("menu-btn").getAttribute("aria-expanded")`), "false");

    // Format works from the menu too, and closes it.
    await page.waitFor(`!document.getElementById("format").disabled`, "Format to be enabled");
    await page.click("#menu-btn");
    await page.click("#format");
    await page.waitFor(`document.getElementById("status").textContent === "formatted"`, "Format from the menu");
    assert.equal(await page.visible("#format"), false, "the menu closed");
  } finally {
    await page.setViewport(1512, 860);
  }
});

test("on a phone the panes stack and nothing scrolls sideways", { skip }, async () => {
  await page.setViewport(390, 800);
  try {
    await fresh();
    assert.equal(await page.eval(`getComputedStyle(document.querySelector("main")).gridTemplateColumns.split(" ").length`), 1);
    assert.equal(await page.eval(`document.documentElement.scrollWidth > innerWidth`), false);
  } finally {
    await page.setViewport(1512, 860);
  }
});

// Last, so it covers every flow above: the page did everything under its policy (#34).
test("nothing the playground does is refused by its Content-Security-Policy", { skip }, async () => {
  await page.goto(app.url);
  assert.deepEqual(await page.eval(`JSON.parse(sessionStorage.getItem("csp-violations") || "[]")`), []);
  // And the policy is in force: an injected inline script is refused.
  await page.eval(`document.body.append(Object.assign(document.createElement("script"), { textContent: "window.__ran = true" }))`);
  await page.waitFor(`JSON.parse(sessionStorage.getItem("csp-violations") || "[]").some((v) => v.startsWith("script-src"))`, "the refusal");
  assert.equal(await page.eval("window.__ran === true"), false);
});
