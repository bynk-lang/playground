// The two real Workers, not the stand-in dev server the other browser tests use: the app
// Worker (assets, /api/* forwarded over the SHARE binding, SHARE_LIMIT rate limit) and the
// sandbox Worker (execution document only, everything else redirected to the app), run
// under `wrangler dev` from the repo's own wrangler.*.jsonc. These are the behaviours a
// deploy ships and the unit tests can only fake. Needs Chrome and network access for
// `npx wrangler@4.152.0` (the same pin ci.yml deploys with).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { findChrome, launchBrowser, startWorkers } from "./harness.mjs";

const chrome = findChrome();
if (!chrome && process.env.REQUIRE_CHROME) throw new Error("REQUIRE_CHROME is set but no Chrome/Chromium was found");
const skip = chrome ? false : "no Chrome/Chromium found (set CHROME=/path/to/chrome)";

let workers, browser, page;

before(async () => {
  if (skip) return;
  workers = await startWorkers();
  browser = await launchBrowser(chrome);
  page = browser.page;
  await page.setViewport(1512, 860);
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await workers?.stop();
  }
});

const settled = () =>
  page.waitFor(`/^(ran|run failed|\\d+ errors?)$/.test(document.getElementById("status").textContent)`, "a finished run");

test("the page runs a snippet through the sandbox Worker", { skip, timeout: 120000 }, async () => {
  await page.goto(workers.appOrigin);
  await page.eval("localStorage.clear()");
  await page.goto(workers.appOrigin);
  await settled();
  assert.equal(await page.text("#status"), "ran");
  assert.match(await page.text("#output"), /⇒ Hello from Bynk!/);
  assert.equal(await page.eval(`document.getElementById("sandbox").src`), `${workers.sandboxOrigin}/sandbox`);
});

test("the sandbox origin serves only the execution document and sends the rest to the app", { skip }, async () => {
  for (const path of ["/", "/index.html", "/app.js", "/?s=abc123"]) {
    const res = await fetch(workers.sandboxOrigin + path, { redirect: "manual" });
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("location"), workers.appOrigin + path, path);
  }
  // Served from the sandbox origin itself: a redirect to the app (which also has these
  // files) must not pass for a 200.
  for (const path of ["/sandbox", "/sandbox.js"]) {
    const res = await fetch(workers.sandboxOrigin + path, { redirect: "manual" });
    assert.equal(res.status, 200, `${path} is served here, not redirected`);
  }
  const html = await fetch(workers.sandboxOrigin + "/sandbox.html", { redirect: "manual" });
  assert.equal(html.status, 307, "the platform's clean-URL redirect, not ours");
  // The platform may send the location relative or absolute: both mean this same origin.
  assert.equal(new URL(html.headers.get("location"), workers.sandboxOrigin).href, `${workers.sandboxOrigin}/sandbox`);
});

test("the app origin refuses the sandbox's files, so untrusted code never runs there", { skip }, async () => {
  for (const path of ["/sandbox", "/sandbox.html", "/sandbox.js", "/sandbox.js.map"]) {
    const res = await fetch(workers.appOrigin + path, { redirect: "manual" });
    assert.equal(res.status, 404, path);
  }
});

test("Share makes a short link through the app Worker and the SHARE binding", { skip }, async () => {
  await page.goto(workers.appOrigin);
  await settled();
  await page.type("// via the worker\n");
  await page.click("#share");
  await page.waitFor(`document.getElementById("share-url").value.includes("?s=")`, "a short link");
  assert.match(await page.text("#share-note"), /expire after 30 days/);
  const link = await page.eval(`document.getElementById("share-url").value`);
  await page.eval(`document.getElementById("share-sheet").close()`);
  await page.goto(link);
  await settled();
  assert.ok((await page.editor()).includes("// via the worker"));
  assert.equal(await page.visible("#shared-note"), true);
});

test("snippet creation is rate limited by the SHARE_LIMIT binding; reads are not", { skip }, async () => {
  await page.goto(workers.appOrigin);
  await settled();
  const statuses = await page.eval(`(async () => {
    const out = [];
    for (let i = 0; i < 14; i++) {
      const r = await fetch("/api/snippets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "context rl.t" + i + "\\n" }) });
      out.push(r.status);
    }
    const read = await fetch("/api/snippets/does-not-exist");
    return { out, read: read.status, retry: (await fetch("/api/snippets", { method: "POST", body: "{}" })).headers.get("retry-after") };
  })()`);
  assert.ok(statuses.out.includes(429), `expected a 429 within 14 creates, got ${statuses.out}`);
  assert.ok(statuses.out.indexOf(429) > 0, "the first create must succeed");
  assert.equal(statuses.out[0], 201);
  assert.equal(statuses.read, 404, "reads still reach the share service once creates are limited");
  assert.equal(statuses.retry, "60");
});
