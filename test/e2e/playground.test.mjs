// The playground's flows in a real browser: the compile → sandbox → result round trip
// across the two origins, the Result/Logs/Compiled JS tabs, the examples gallery, the
// tour and its saved progress, the share sheet and fork bar, draft restore and Recent,
// the theme toggle, and the phone layout. Skipped (with a note) when no Chrome is
// found. Run: `npm run test:e2e` (after `npm run fetch:assets`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  page.waitFor(`/^(ran|run failed|check arguments|needs arguments|\\d+ errors?|link copied)$/.test(document.getElementById("status").textContent)`, "a finished run");

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
  // The formatter's failure is the playground's own, not a compiler code: no docs link, no hint.
  assert.equal(await page.eval(`document.querySelector(".diag a, .diag-hint")`), null);
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
  assert.equal(await page.eval(`document.querySelector(".diag .diag-jump")?.tagName`), "BUTTON");
  assert.match(await page.text("#output"), /Fix the \d+ errors? above/);
});

test("a diagnostic links its code to the Book, hints at a fix, and still jumps to the spot", { skip }, async () => {
  share.store.set(
    "nogiven",
    'context demo.t\n\nconsumes bynk { Logger }\n\nservice s {\n\ton call() -> Effect[String] {\n\t\tlet _ <- Logger.info("hi")\n\t\t"x"\n\t}\n}\n',
  );
  await fresh("?s=nogiven");
  await page.click("#run");
  await page.waitFor(`document.querySelector(".diag")`, "a diagnostic row");
  const link = await page.eval(`(() => {
    const a = document.querySelector(".diag a.diag-cat");
    return a && { text: a.textContent, href: a.href, target: a.target, inButton: !!a.closest("button") };
  })()`);
  assert.deepEqual(link, {
    text: "bynk.given.undeclared_capability ↗",
    href: "https://bynk-lang.org/book/reference/diagnostics/#given-capabilities",
    target: "_blank",
    inButton: false,
  });
  assert.match(await page.text(".diag-hint"), /^Try: List the capability after given/);
  assert.equal(await page.eval(`document.querySelector(".diag-hint code")?.textContent`), "given");

  // The message is still a button that puts the cursor on the offending line.
  await page.click(".diag-jump");
  assert.match(await page.text(".cm-activeLine"), /Logger\.info/);
});

test("on a wide screen the compiled JS moves beside the editor, follows each run, and stays there", { skip }, async () => {
  await page.setViewport(1440, 900);
  try {
    await fresh();
    await page.click("#tab-js");
    assert.equal(await page.visible("#js-pane"), false);
    await page.click("#js-beside");
    assert.equal(await page.visible("#js-pane"), true);
    assert.equal(await page.visible("#tab-js"), false, "the tab gives way to the column");
    assert.equal(await page.eval(`document.querySelector("[role=tab][aria-selected=true]").id`), "tab-result");
    assert.match(await page.text("#js-pane-body"), /\/\/ hello\/world\.js/);
    assert.match(await page.text("#output"), /Hello from Bynk!/, "the result stays in view");
    const x = (sel) => page.eval(`document.querySelector("${sel}").getBoundingClientRect().left`);
    assert.ok((await x("#editor")) < (await x("#js-pane")) && (await x("#js-pane")) < (await x("#output")), "editor, JS, then the result");

    // It follows the program: load another and run it.
    await page.click("#examples");
    await page.eval(`[...document.querySelectorAll("#gallery-grid .card")].find((c) => c.querySelector(".card-title").textContent === "Records").click()`);
    await settled();
    assert.match(await page.text("#js-pane-body"), /\/\/ demo\/records\.js/);

    // Kept for the next visit.
    await page.goto(app.url);
    await settled();
    assert.equal(await page.visible("#js-pane"), true);

    // Too narrow for three columns: the tab is back, and the column is gone.
    await page.setViewport(1000, 800);
    assert.equal(await page.visible("#js-pane"), false);
    assert.equal(await page.visible("#tab-js"), true);
    await page.setViewport(1440, 900);

    // Back to the tab.
    await page.click("#js-pane-close");
    assert.equal(await page.visible("#js-pane"), false);
    assert.equal(await page.eval(`document.activeElement.id`), "tab-js");
    assert.match(await page.text("#output"), /\/\/ demo\/records\.js|\/\/ hello\/world\.js/);
  } finally {
    await page.setViewport(1512, 860);
  }
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
  assert.equal(await page.eval(`document.querySelector("#output [data-about]")?.textContent`), "Why?", "the limit links to What runs here");
  assert.equal(await page.text("#logs-badge"), "1");
  await page.click("#tab-logs");
  assert.match(await page.text("#output"), /slow/);
});

test("What runs here opens from the Learn menu, the gallery and every limit message", { skip }, async () => {
  const opened = () => page.eval(`document.getElementById("about-runs").open`);
  const close = () => page.click("#about-runs .gallery-head button");

  // Without hitting a limit: from Learn, and from the gallery (over it, so Close goes back).
  await fresh();
  await page.click("#learn-btn");
  await page.click("#learn-links [data-about]");
  assert.equal(await opened(), true);
  assert.equal(await page.visible("#learn-links"), false, "the dropdown closes behind it");
  const text = await page.text("#about-runs");
  for (const want of [/on call\(\) -> …/, /stopped after 3 seconds/, /Logger/, /Fetch and Secrets/, /bynk\.cloudflare/, /Install Bynk/, /under Arguments/]) assert.match(text, want);
  await page.key("Escape");
  assert.equal(await opened(), false);
  // The item that opened it has closed with the dropdown, so focus goes back to Learn.
  // (The dialog's close event, which moves it, fires a moment after Escape.)
  await page.waitFor(`document.activeElement.id === "learn-btn"`, "focus back on Learn");
  await page.click("#examples");
  await page.click("#gallery [data-about]");
  assert.equal(await opened(), true);
  await close();
  assert.equal(await page.eval(`document.getElementById("gallery").open`), true, "back in the gallery");
  await page.click("#gallery .gallery-head button");

  // Each limit carries its own way in.
  const limits = {
    // An HTTP route compiles but isn't an entry, as the note says.
    route: ['context demo.t\n\nactor Visitor { auth = None }\n\nservice api from http {\n\ton GET("/") () -> Effect[HttpResult[String]] by Visitor {\n\t\tOk("hi")\n\t}\n}\n', "#output"],
    secrets: ['context demo.t\n\nconsumes bynk { Secrets }\n\nservice s {\n\ton call() -> Effect[String] given Secrets {\n\t\tlet _ <- Secrets.get("KEY")\n\t\t"x"\n\t}\n}\n', "#output"],
    platform: ['context demo.t\n\nconsumes bynk.cloudflare { Kv }\n\nservice s {\n\ton call() -> Effect[String] given Kv {\n\t\t"x"\n\t}\n}\n', "#unsupported"],
  };
  for (const [id, [source, where]] of Object.entries(limits)) {
    share.store.set(id, source);
    await fresh(`?s=${id}`);
    await page.click("#run");
    await page.waitFor(`document.querySelector("${where} [data-about]")`, `the ${id} message's link`);
    await page.click(`${where} [data-about]`);
    assert.equal(await opened(), true, id);
    await close();
  }
});

test("the standard library reference opens from Learn and finds how to parse an Int", { skip }, async () => {
  await fresh();
  await page.click("#learn-btn");
  await page.click("#learn-links [data-reference]");
  assert.equal(await page.eval(`document.getElementById("reference").open`), true);
  assert.equal(await page.eval(`document.activeElement.id`), "reference-search");
  await page.waitFor(`document.querySelector("#reference-list .ref-group")`, "the reference, read from the compiler");
  for (const section of ["Types", "Capabilities", "Modules"]) {
    assert.ok((await page.eval(`[...document.querySelectorAll("#reference-list > h3")].map((h) => h.textContent)`)).includes(section), section);
  }
  await page.eval(`(() => { const s = document.getElementById("reference-search"); s.value = "parse int"; s.dispatchEvent(new Event("input")); })()`);
  const lines = await page.eval(`[...document.querySelectorAll("#reference-list li code")].map((c) => c.textContent)`);
  assert.ok(lines.includes("Int.parse(s: String) -> Option[Int]"), lines.join("\n"));
  await page.eval(`(() => { const s = document.getElementById("reference-search"); s.value = "zzzz"; s.dispatchEvent(new Event("input")); })()`);
  assert.match(await page.text("#reference-list"), /Nothing matches/);
  await page.click("#reference .gallery-head button");
  await page.waitFor(`document.activeElement.id === "learn-btn"`, "focus back on Learn");
});

const GREET =
  'context demo.greet\n\ntype Slug = String where Matches("[a-z]+")\n\nservice greet {\n\ton call(name: String, times: Int, tag: Slug) -> Effect[String] {\n\t\tname.concat(" x").concat(times.toString()).concat(" #").concat(tag)\n\t}\n}\n';

// Set an Arguments field the way typing does.
const setArg = (name, value) =>
  page.eval(`(() => {
    const label = [...document.querySelectorAll("#args .arg")].find((l) => l.querySelector(".arg-name").firstChild.textContent === ${JSON.stringify(name)});
    const input = label.querySelector("input");
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);

test("a handler that takes arguments runs with the values under Arguments, no editing needed", { skip }, async () => {
  share.store.set("greet", GREET);
  await fresh("?s=greet");
  await page.waitFor(`!document.getElementById("args").hidden`, "the Arguments row");
  assert.deepEqual(
    await page.eval(`[...document.querySelectorAll("#args .arg-name")].map((n) => n.textContent)`),
    ["name: String", "times: Int", "tag: Slug"],
  );
  // Opened with empty fields, it waits for them rather than reporting them as wrong.
  assert.equal(await page.text("#status"), "needs arguments");
  assert.match(await page.text("#output"), /Fill in the arguments above, then press Run/);
  // Run with them still empty says which one is missing.
  await page.click("#run");
  await page.waitFor(`document.getElementById("status").textContent === "check arguments"`, "the argument check");
  assert.match(await page.text("#output"), /Can't call the handler: `times` needs a whole number/);

  const run = async (want) => {
    await page.click("#run");
    await page.waitFor(`/ran|check arguments|failed/.test(document.getElementById("status").textContent)`, "the run");
    assert.match(await page.text("#output"), want);
  };
  await setArg("name", "Ada");
  await setArg("times", "2");
  await setArg("tag", "hello");
  await run(/⇒ Ada x2 #hello/);
  await setArg("name", "Grace");
  await run(/⇒ Grace x2 #hello/);
  assert.match(await page.editor(), /on call\(name: String/, "the program wasn't edited");

  // A value that fails its refinement is reported against the argument, not as a crash.
  await setArg("tag", "Hello");
  await run(/Can't call the handler: `tag` must match \/\[a-z\]\+\/ \(Slug\)/);
  assert.equal(await page.text("#status"), "check arguments");

  // Enter in a field runs.
  await setArg("tag", "ok");
  await page.eval(`document.querySelector("#args input").focus()`);
  await page.key("Enter");
  await page.waitFor(`/Grace x2 #ok/.test(document.getElementById("output").textContent)`, "the Enter run");
});

test("a shared link keeps its arguments, as a short link and as a self-contained one", { skip }, async () => {
  share.store.set("greet2", GREET);
  await fresh("?s=greet2");
  await page.waitFor(`!document.getElementById("args").hidden`, "the Arguments row");
  await setArg("name", "Lin");
  await setArg("times", "3");
  await setArg("tag", "abc");
  await page.click("#share");
  await page.waitFor(`document.getElementById("share-url").value`, "a share link");
  const short = await page.eval(`document.getElementById("share-url").value`);
  assert.match(short, /\?s=[^&]+&args=/);
  await fresh(short.replace(/^https?:\/\/[^/]+\/?/, "/").replace(/^\//, ""));
  await page.waitFor(`/Lin x3 #abc/.test(document.getElementById("output").textContent)`, "the short link's run");

  // The self-contained link, when the share service is down.
  share.state.down = true;
  await page.click("#share-sheet .gallery-head button");
  await page.click("#share");
  await page.waitFor(`document.getElementById("share-url").value.includes("#")`, "a self-contained link");
  const hash = await page.eval(`document.getElementById("share-url").value`);
  assert.match(hash, /\?args=[^#]+#/);
  await fresh(hash.replace(/^https?:\/\/[^/]+\//, ""));
  await page.waitFor(`/Lin x3 #abc/.test(document.getElementById("output").textContent)`, "the self-contained link's run");
});

test("a handler whose argument can't be entered says so, rather than that there's no handler", { skip }, async () => {
  share.store.set("point", "context demo.p\n\ntype Point = { x: Int, y: Int }\n\nservice s {\n\ton call(p: Point, n: Int) -> Effect[Int] {\n\t\tn\n\t}\n}\n");
  await fresh("?s=point");
  assert.match(await page.text("#args"), /p: Point\s*can't be entered here yet/);
  assert.match(await page.text("#output"), /Can't call the handler: a `Point` can't be entered here yet/);
  assert.doesNotMatch(await page.text("#output"), /No service handler/);
});

test("a zero-argument program has no Arguments row, and loading an example drops link arguments", { skip }, async () => {
  await fresh(`?args=${encodeURIComponent('{"name":"x"}')}`);
  assert.equal(await page.eval(`document.getElementById("args").hidden`), true);
  assert.match(await page.text("#output"), /Hello from Bynk!/);

  share.store.set("greet4", GREET);
  await fresh(`?s=greet4&args=${encodeURIComponent(JSON.stringify({ name: "Ada", times: "2", tag: "x" }))}`);
  await page.waitFor(`/Ada x2 #x/.test(document.getElementById("output").textContent)`, "the run with link arguments");
  await page.click("#examples");
  await page.click("#gallery-grid .card");
  await settled();
  assert.doesNotMatch(await page.eval(`location.search`), /args/);
  assert.equal(await page.eval(`document.getElementById("args").hidden`), true);
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

test("the gallery reads in sections from a starting point, and examples and tour steps link to each other", { skip }, async () => {
  await fresh();
  await page.click("#examples");
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#gallery-grid .gallery-group > h3")].map((h) => h.textContent)`), [
    "Start here",
    "Data types",
    "Functions and collections",
    "Missing values and errors",
  ]);
  assert.equal(await page.eval(`document.querySelector("#gallery-grid .card-title").textContent`), "Hello, world");

  // An example → the tour step for the same idea.
  const practise = await page.eval(`(() => {
    const card = [...document.querySelectorAll("#gallery-grid .card")].find((c) => c.querySelector(".card-title").textContent === "Records");
    return card.parentElement.querySelector(".card-tour").textContent;
  })()`);
  assert.equal(practise, "Practise this in the tour (step 3) ›");
  await page.eval(`[...document.querySelectorAll("#gallery-grid .card")].find((c) => c.querySelector(".card-title").textContent === "Records").parentElement.querySelector(".card-tour").click()`);
  await page.waitFor(`document.getElementById("tour-count").textContent.includes("step 3 of")`, "tour step 3");
  assert.equal(await page.eval(`document.getElementById("gallery").open`), false);

  // The tour step → its example, leaving the tour.
  assert.equal(await page.text("#tour-example"), "See a full example: Records ›");
  await page.click("#tour-example");
  await settled();
  assert.equal(await page.eval(`document.getElementById("tour").hidden`), true);
  assert.match(await page.editor(), /context demo\.records/);
  await page.click("#examples");
  assert.match(await page.eval(`document.querySelector('#gallery-grid .card[aria-current="true"] .card-title').textContent`), /Records/);

  // Searching hides the sections it empties.
  await page.eval(`(() => { const s = document.getElementById("gallery-search"); s.value = "maps"; s.dispatchEvent(new Event("input")); })()`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#gallery-grid .gallery-group > h3")].map((h) => h.textContent)`), ["Functions and collections"]);
});

test("the gallery points to the Book for what a playground file can't hold", { skip }, async () => {
  await fresh();
  await page.click("#examples");
  assert.equal(await page.visible("#beyond"), true);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#beyond a")].map((a) => [a.textContent, a.href, a.target])`), [
    ["An HTTP service ↗", "https://bynk-lang.org/book/tutorials/02-http-service/", "_blank"],
    ["Testing ↗", "https://bynk-lang.org/book/tutorials/06-testing/", "_blank"],
    ["Modules and several contexts ↗", "https://bynk-lang.org/book/guides/program-structure/how-a-program-is-shaped/", "_blank"],
  ]);
  // The new examples are there to search for.
  for (const [q, id] of [["maps", "Maps"], ["recursion", "Recursion"], ["strings", "Strings"]]) {
    await page.eval(`(() => { const s = document.getElementById("gallery-search"); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event("input")); })()`);
    assert.ok((await page.eval(`[...document.querySelectorAll("#gallery-grid .card-title")].map((t) => t.textContent)`)).includes(id), id);
  }
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

test("finishing the tour shows where to go next, with the tour to start over", { skip }, async () => {
  // Pass the last step and press Finish.
  const finish = async () => {
    await fresh("?tour=question");
    await page.waitFor(`document.getElementById("tour-count").textContent.includes("step 9 of")`, "the last step");
    await page.click("#tour-solution");
    await page.click("#tour-check");
    await page.waitFor(`document.getElementById("tour-feedback").dataset.kind === "ok"`, "the last step passes");
    assert.equal(await page.text("#tour-next"), "Finish");
    await page.click("#tour-next");
  };
  await finish();
  assert.equal(await page.visible("#tour"), false);
  assert.equal(await page.visible("#tour-end"), true);
  assert.equal(await page.eval(`document.activeElement.id`), "tour-end-title", "focus moves to the panel, as Finish has gone");
  assert.equal(await status(), "tour complete");
  const hrefs = await page.eval(`[...document.querySelectorAll("#tour-end a")].map((a) => a.href)`);
  for (const want of ["https://bynk-lang.org/book/tutorials/02-http-service/", "https://bynk-lang.org/book/", "https://bynk-lang.org/book/introduction/install/"]) {
    assert.ok(hrefs.includes(want), want);
  }

  // Browse the examples opens the gallery; Close puts the panel away.
  await page.click("#tour-end-examples");
  assert.equal(await page.eval(`document.getElementById("gallery").open`), true);
  await page.eval(`document.getElementById("gallery").close()`);
  await page.click("#tour-end-close");
  assert.equal(await page.visible("#tour-end"), false);

  // Start tour over goes back to step 1 with progress cleared.
  await finish();
  await page.click("#tour-end-restart");
  await page.waitFor(`document.getElementById("tour-count").textContent.includes("step 1 of")`, "tour step 1");
  assert.equal(await page.visible("#tour-end"), false);
  assert.equal(await page.text("#tour-btn"), "Tour");
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
  for (const hidden of ["#share", "#examples", "#tour-btn", "#theme", "#learn", "#format", "#shared-note"]) {
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
  // The icon shows the theme a click switches to.
  const icon = () => page.eval(`[...document.querySelectorAll("#theme svg")].find((s) => s.getClientRects().length).classList[0]`);
  assert.equal(await icon(), before === "dark" ? "icon-sun" : "icon-moon");
  await page.click("#theme");
  const after = await page.eval(`document.documentElement.dataset.theme`);
  assert.notEqual(after, before);
  assert.equal(await icon(), after === "dark" ? "icon-sun" : "icon-moon");
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

// Each width is the narrowest of a --ui-scale step, where the toolbar is tightest.
test("on a wide screen the toolbar fits one row with no button wrapped and short statuses whole, at every scale", { skip }, async () => {
  try {
    for (const width of [801, 1000, 1400]) {
      await page.setViewport(width, 800);
      await fresh();
      // The longest status the toolbar shows: it truncates rather than pushing the row wider.
      await page.eval(`document.getElementById("status").textContent = "forked: this is your copy"`);
      assert.equal(await page.eval(`document.documentElement.scrollWidth > innerWidth`), false, `${width}px: nothing scrolls sideways`);
      const wrapped = await page.eval(`[...document.querySelectorAll("header button")].filter((b) => b.getClientRects().length && b.offsetHeight > parseFloat(getComputedStyle(b).minHeight) + 1).map((b) => b.id)`);
      assert.deepEqual(wrapped, [], `${width}px: buttons on one line`);
      // Run drops its shortcut hint here, so a short status is shown whole.
      assert.equal(await page.visible("#run-key"), false, `${width}px: Run's shortcut hint gives way`);
      for (const text of ["ran", "12 errors"]) {
        await page.eval(`document.getElementById("status").textContent = ${JSON.stringify(text)}`);
        assert.equal(await page.eval(`(() => { const s = document.getElementById("status"); return s.scrollWidth > s.clientWidth; })()`), false, `${width}px: "${text}" is not cut short`);
      }
    }
    // Away from the steps the hint is back.
    await page.setViewport(1200, 800);
    assert.equal(await page.visible("#run-key"), true, "1200px: Run shows its shortcut");
  } finally {
    await page.setViewport(1512, 860);
  }
});

test("on a wide screen Learn opens a dropdown of links to the Book, install and source", { skip }, async () => {
  await fresh();
  const x = (id) => page.eval(`document.querySelector("${id}").getBoundingClientRect().left`);
  assert.ok((await x("#tour-btn")) < (await x("#learn-btn")) && (await x("#learn-btn")) < (await x("#run")), "Tour, Learn, then Run");
  assert.equal(await page.visible("#learn-links"), false);
  const hrefs = await page.eval(`[...document.querySelectorAll("#learn-links a")].map((a) => a.href)`);
  for (const want of ["https://bynk-lang.org/book/", "https://bynk-lang.org/book/introduction/install/", "https://github.com/bynk-lang/bynk", "https://github.com/bynk-lang/playground"]) {
    assert.ok(hrefs.includes(want), want);
  }
  assert.equal(await page.eval(`[...document.querySelectorAll("#learn-links a")].every((a) => a.target === "_blank" && a.rel.includes("noopener"))`), true);

  // Last, the compiler release the build bundles, linking to its notes (#79).
  const version = readFileSync(new URL("../../src/vendor/VERSION", import.meta.url), "utf8").trim();
  assert.equal(await page.eval(`document.querySelector("#learn-links a:last-of-type").id`), "bynk-version");
  assert.equal(await page.eval(`document.getElementById("bynk-version").textContent`), `Bynk ${version} release notes ↗`);
  assert.equal(await page.eval(`document.getElementById("bynk-version").href`), `https://github.com/bynk-lang/bynk/releases/tag/${version}`);

  // Opening moves focus to the first item; Escape closes it and returns focus to the button.
  await page.click("#learn-btn");
  assert.equal(await page.visible("#learn-links"), true);
  assert.equal(await page.eval(`document.getElementById("learn-btn").getAttribute("aria-expanded")`), "true");
  assert.equal(await page.eval(`document.activeElement.textContent`), "What runs here");
  await page.key("Escape");
  assert.equal(await page.visible("#learn-links"), false);
  assert.equal(await page.eval(`document.activeElement.id`), "learn-btn");

  // A click elsewhere closes it.
  await page.click("#learn-btn");
  await page.eval(`document.querySelector("main").click()`);
  assert.equal(await page.visible("#learn-links"), false);
  assert.equal(await page.eval(`document.getElementById("learn-btn").getAttribute("aria-expanded")`), "false");
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
    // Learn's links are items in the menu, not a dropdown of their own.
    assert.equal(await page.visible("#learn-btn"), false);
    assert.equal(await page.visible("#learn-links a"), true);
    assert.equal(await page.visible("#bynk-version"), true, "the compiler version is in the menu too");
    assert.equal(await page.eval(`document.documentElement.scrollWidth > innerWidth`), false);
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
