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

export const freePort = () =>
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
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      // CI runners have a small /dev/shm, which crashes Chrome's renderers.
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    // Its own process group, so every helper process Chrome starts can be killed with it.
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  // Kill Chrome and its helpers and let go of its pipes, or an orphan holding them keeps
  // the test process alive after the tests are done.
  const stopChrome = () => {
    try {
      process.kill(-proc.pid);
    } catch {
      proc.kill();
    }
    proc.stderr.destroy();
    proc.unref();
  };
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  // If anything below throws, Chrome must still be killed or the test process never exits.
  let ws;
  try {
    // 127.0.0.1, not `localhost`, which may resolve to ::1 where Chrome is not listening.
    let targets;
    for (let i = 0; i < 300 && !targets; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      } catch {
        await sleep(100);
      }
    }
    const pageTarget = targets?.find((t) => t.type === "page");
    if (!pageTarget) throw new Error(`Chrome did not expose DevTools on port ${port} within 30s. stderr:\n${stderr}`);
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("DevTools WebSocket failed to open"));
    });
  } catch (e) {
    stopChrome();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  // A command that never answers (a crashed page) must fail the test, not hang the run.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`DevTools command ${method} timed out after 30s`));
      }, 30000);
      pending.set(i, (m) => (clearTimeout(timer), resolve(m)));
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
      stopChrome();
      // Chrome may still be flushing its profile for a moment after it is killed.
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

/// Run the two real Workers (the app, with the share service bound, and the sandbox)
/// under `wrangler dev`, built from the repo's own wrangler.*.jsonc, so the Worker
/// scripts, the SHARE and SHARE_LIMIT bindings, run_worker_first and the sandbox
/// redirect are all the shipped ones. Only the share service is a stand-in
/// (test/e2e/fake-share.mjs).
export async function startWorkers() {
  const { readFileSync, writeFileSync, openSync } = await import("node:fs");
  const { withShareBinding } = await import(new URL("../../scripts/with-share-binding.mjs", import.meta.url));
  const [appPort, sandboxPort] = [await freePort(), await freePort()];
  const appOrigin = `http://localhost:${appPort}`;
  const sandboxOrigin = `http://localhost:${sandboxPort}`;
  const out = ".e2e-workers-dist";
  execFileSync("node", ["build.mjs"], {
    cwd: root,
    env: { ...process.env, BYNK_APP_ORIGIN: appOrigin, BYNK_SANDBOX_ORIGIN: sandboxOrigin, BYNK_OUT_DIR: out },
    stdio: "ignore",
  });
  const dir = await mkdtemp(join(tmpdir(), "bynk-workers-"));
  const abs = (p) => join(root, p);
  const read = (f) => readFileSync(abs(f), "utf8");
  const strip = (s) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, ""));
  const local = (cfg) => {
    // Absolute paths (the config now lives in a temp dir), no domains, the test's dist.
    delete cfg.routes;
    cfg.main = abs(cfg.main.replace(/^\.\//, ""));
    cfg.assets.directory = abs(out);
    return cfg;
  };
  const appConfig = local(withShareBinding(read("wrangler.app.jsonc")));
  const sandboxConfig = local(strip(read("wrangler.sandbox.jsonc")));
  sandboxConfig.vars = { ...sandboxConfig.vars, APP_ORIGIN: appOrigin };
  const fakeConfig = { name: "snippets", main: abs("test/e2e/fake-share.mjs"), compatibility_date: appConfig.compatibility_date };
  const write = (name, cfg) => (writeFileSync(join(dir, name), JSON.stringify(cfg)), join(dir, name));
  const files = { app: write("app.json", appConfig), sandbox: write("sandbox.json", sandboxConfig), fake: write("fake.json", fakeConfig) };

  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  const procs = [];
  const start = (args, port, label) => {
    const p = spawn("npx", ["--yes", "wrangler@4.152.0", "dev", "--local", "--port", String(port), "--inspector-port", String(args.inspector),
      // Each session keeps its own local state: two sharing one lock each other out (SQLITE_BUSY).
      "--persist-to", join(dir, `state-${label}`), ...args.configs.flatMap((c) => ["-c", c])], {
      cwd: root,
      env,
      stdio: ["ignore", process.env.BYNK_WORKERS_LOG ? openSync(`${process.env.BYNK_WORKERS_LOG}.${label}`, "w") : "ignore", "pipe"],
      detached: true,
    });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-3000)));
    procs.push(p);
    return { p, label, stderr: () => stderr, port };
  };
  const stop = () => {
    for (const p of procs) {
      try {
        process.kill(-p.pid);
      } catch {
        p.kill();
      }
      p.stderr.destroy();
      p.unref();
    }
    return rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  };
  const servers = [
    start({ configs: [files.app, files.fake], inspector: await freePort() }, appPort, "app"),
    start({ configs: [files.sandbox], inspector: await freePort() }, sandboxPort, "sandbox"),
  ];
  try {
    for (const s of servers) {
      let up = false;
      for (let i = 0; i < 900 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${s.port}/`, { redirect: "manual" })).status > 0;
        } catch {
          await sleep(100);
        }
      }
      if (!up) throw new Error(`wrangler dev (${s.label}) did not answer on ${s.port} within 90s. stderr:\n${s.stderr()}`);
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { appOrigin, sandboxOrigin, stop };
}
