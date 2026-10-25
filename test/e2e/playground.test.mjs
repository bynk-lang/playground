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
});

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
  for (const hidden of ["#share", "#examples", "#tour-btn", "#theme", "#shared-note"]) {
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
