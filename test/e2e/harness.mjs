// Browser-test harness with no dependencies: build the playground for two localhost
// ports (the app and the sandbox must be different origins, like production), serve it
// with serve.mjs beside a fake share service, and drive headless Chrome over the
// DevTools protocol. Needs `npm run fetch:assets` first and a Chrome/Chromium
// (CHROME=/path/to/chrome, else the first of the usual names on PATH).
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttp } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    try {
      return execFileSync("which", [name], { encoding: "utf8" }).trim();
    } catch {
      // try the next name
    }
  }
  return null;
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A stand-in for the Bynk share service: POST /api/snippets {source} -> {id},
/// GET /api/snippets/:id -> {source}. `down` makes it answer 503 (the hash fallback).
export async function startFakeShare() {
  const store = new Map();
  const state = { down: false };
  const server = createHttp((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.down) return json(503, { error: "down" });
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const id = `t${store.size + 1}`;
        store.set(id, JSON.parse(Buffer.concat(chunks).toString()).source);
        json(200, { id });
      });
      return;
    }
    const id = req.url.split("/").pop();
    store.has(id) ? json(200, { source: store.get(id) }) : json(404, { error: "no such snippet" });
  });
  await new Promise((r) => server.listen(0, r));
  return {
    port: server.address().port,
    state,
    // serve.mjs keeps its proxy connection alive, which would hold the process open.
    close: () => (server.closeAllConnections(), server.close()),
  };
}

export async function startApp(sharePort) {
  const [appPort, sandboxPort] = [await freePort(), await freePort()];
  const out = ".e2e-dist";
  const env = {
    ...process.env,
    BYNK_APP_ORIGIN: `http://localhost:${appPort}`,
    BYNK_SANDBOX_ORIGIN: `http://localhost:${sandboxPort}`,
    BYNK_OUT_DIR: out,
    BYNK_APP_PORT: String(appPort),
    BYNK_SANDBOX_PORT: String(sandboxPort),
    BYNK_SHARE_WORKER: `http://localhost:${sharePort}`,
  };
  execFileSync("node", ["build.mjs"], { cwd: root, env, stdio: "ignore" });
  const server = spawn("node", ["serve.mjs"], { cwd: root, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${appPort}/`)).ok) break;
    } catch {
      await sleep(100);
    }
  }
  return { url: `http://localhost:${appPort}/`, stop: () => server.kill() };
}

export async function launchBrowser(chrome) {
  const profile = await mkdtemp(join(tmpdir(), "bynk-e2e-"));
  const port = await freePort();
  const proc = spawn(
    chrome,
    ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"],
    { stdio: "ignore" },
  );
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      targets = await (await fetch(`http://localhost:${port}/json`)).json();
    } catch {
      await sleep(100);
    }
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    }).then((m) => m.result);
  await send("Page.enable");

  const page = {
    send,
    /// Evaluate an expression in the page and return its (JSON-serialisable) value.
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      return r?.result?.value;
    },
    /// Poll until `expression` is truthy; fail with `what` after `timeout` ms.
    async waitFor(expression, what = expression, timeout = 15000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const v = await page.eval(expression);
        if (v) return v;
        await sleep(100);
      }
      throw new Error(`timed out waiting for: ${what}`);
    },
    async goto(url) {
      await send("Page.navigate", { url });
      await page.waitFor(`document.readyState === "complete"`, "page load");
    },
    async setViewport(width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async key(key, { ctrl = false } = {}) {
      const vk = { Enter: 13, Escape: 27, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 }[key];
      const base = { key, code: key, modifiers: ctrl ? 2 : 0, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      const text = key === "Enter" && !ctrl ? { text: "\r" } : {};
      await send("Input.dispatchKeyEvent", { type: text.text ? "keyDown" : "rawKeyDown", ...base, ...text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    /// Insert text at the editor cursor, as typing would.
    async type(text) {
      await page.eval(`document.querySelector(".cm-content").focus()`);
      await send("Input.insertText", { text });
    },
    click: (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`),
    text: (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`),
    visible: (selector) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`),
    editor: () => page.eval(`document.querySelector(".cm-content").innerText`),
  };
  return {
    page,
    async close() {
      ws.close();
      proc.kill();
      // Chrome may still be flushing its profile for a moment after it is killed.
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}
