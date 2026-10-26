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
    // The snippets held, by id, so a test can open `?s=<id>` on one it seeded.
    store,
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

/// `launchBrowserOnce`, tried up to three times when Chrome comes up but never exposes its
/// DevTools endpoint. That happened once in CI on a loaded runner (after a 30s wait, with
/// nothing on stderr), so a fresh process on a fresh port gets another go; any other failure
/// is real and throws at once.
export async function launchBrowser(chrome) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await launchBrowserOnce(chrome);
    } catch (e) {
      last = e;
      if (!/did not expose DevTools|DevTools WebSocket failed to open/.test(String(e))) throw e;
    }
  }
  throw new Error(`${last.message}\n(after 3 launch attempts)`);
}

async function launchBrowserOnce(chrome) {
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
  // Whether Chrome died, so a failure says "exited" rather than leaving it to be guessed.
  let exited = "was still running";
  proc.on("exit", (code, signal) => (exited = `exited (code ${code}, signal ${signal})`));
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
    if (!pageTarget) throw new Error(`Chrome did not expose DevTools on port ${port} within 30s; the process ${exited}. stderr:\n${stderr}`);
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
    /// Press a key; `ctrl`, `alt` and `shift` are held. A single letter ("f") is the KeyF key.
    async key(key, { ctrl = false, alt = false, shift = false } = {}) {
      const letter = /^[a-z]$/i.test(key);
      const vk = letter ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 }[key];
      const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
      const base = { key: shift && letter ? key.toUpperCase() : key, code: letter ? `Key${key.toUpperCase()}` : key, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      const text = key === "Enter" && !modifiers ? { text: "\r" } : {};
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
// How long the two `wrangler dev` processes together may take to answer.
const WRANGLER_START_MS = 120000;

/// A free port not already handed out in `used`: the OS may return a port it just released,
/// and every port here is baked into the build or given to a wrangler session.
async function uniquePort(used) {
  for (;;) {
    const port = await freePort();
    if (!used.has(port)) return used.add(port), port;
  }
}

/// `startWorkersOnce`, retried when a port was taken between being chosen and being bound.
/// A free port is only free until something else binds it (the other wrangler session picks
/// ports of its own, and the build runs in between), so on "Address already in use" start
/// again from fresh ports; any other failure is real and is thrown at once.
export async function startWorkers() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startWorkersOnce();
    } catch (e) {
      if (attempt >= 3 || !/Address already in use/.test(String(e))) throw e;
    }
  }
}

async function startWorkersOnce() {
  const { readFileSync, writeFileSync, openSync } = await import("node:fs");
  const { withShareBinding } = await import(new URL("../../scripts/with-share-binding.mjs", import.meta.url));
  const used = new Set();
  const [appPort, sandboxPort] = [await uniquePort(used), await uniquePort(used)];
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
    start({ configs: [files.app, files.fake], inspector: await uniquePort(used) }, appPort, "app"),
    start({ configs: [files.sandbox], inspector: await uniquePort(used) }, sandboxPort, "sandbox"),
  ];
  // One deadline for both, well inside the test file's own timeout (package.json), so a
  // slow start fails here with wrangler's stderr rather than as a bare file timeout (#43).
  const deadline = Date.now() + WRANGLER_START_MS;
  try {
    for (const s of servers) {
      let up = false;
      while (!up && Date.now() < deadline) {
        try {
          up = (await fetch(`http://127.0.0.1:${s.port}/`, { redirect: "manual" })).status > 0;
        } catch {
          await sleep(100);
        }
      }
      if (!up) {
        throw new Error(`wrangler dev (${s.label}) did not answer on ${s.port} within ${WRANGLER_START_MS / 1000}s. stderr:\n${s.stderr()}`);
      }
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { appOrigin, sandboxOrigin, stop };
}
