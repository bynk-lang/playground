// The execution document — served from the **sandbox origin** and embedded by the
// app as `<iframe sandbox="allow-scripts">` (in-browser track, slice 4; ADR 0140).
//
// It is the safety boundary: it accepts a compiled JS module graph from the app
// origin (and only that origin), links it into blob-URL ES modules, and runs it in
// a **Web Worker** under a hard wall-clock budget — so an infinite loop or runaway
// is `terminate()`d, never wedging anything. `Fetch`/`Secrets` already throw in the
// browser binding (slice 2), so the sandbox cannot reach the network or secrets.
// The Worker captures `Logger` output and the entry's return value and posts them
// back; nothing else crosses the boundary.

import { pickEntry } from "./entry";
import type { EntryKind } from "./entry";
import { APP_ORIGIN } from "./shared";
import type { EmittedFile, RunReply, RunRequest, SandboxConnect } from "./shared";

/** Resolve a relative import specifier against the importing module's path. */
function resolvePath(fromPath: string, spec: string): string {
  const baseDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const out: string[] = [];
  for (const seg of `${baseDir}/${spec}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const SPEC_RE = /(\bfrom\s*|\bimport\s*)(["'])([^"']+)\2/g;

/** Relative import specifiers a module declares (the edges of the graph). */
function importsOf(contents: string): string[] {
  const specs: string[] = [];
  for (const m of contents.matchAll(SPEC_RE)) {
    if (m[3].startsWith(".")) specs.push(m[3]);
  }
  return specs;
}

/**
 * Link the emitted module graph into blob-URL ES modules and return the entry's blob
 * URL (`compose.js`, or for a program with no capabilities the context module itself:
 * see entry.ts). The graph is a DAG (runtime → bynk → binding → context → compose), so
 * we create blobs in dependency order, rewriting each module's
 * relative specifiers to the already-created blob URLs of its targets. (Workers
 * don't support import maps, so specifier rewriting is the portable approach.)
 */
function linkGraph(files: EmittedFile[]): { entry: string | null; kind: EntryKind; urls: string[] } {
  const byPath = new Map<string, EmittedFile>();
  for (const f of files) byPath.set(f.path, f);

  const blobUrls = new Map<string, string>();
  const created: string[] = [];
  const visiting = new Set<string>();

  const build = (path: string): string => {
    const existing = blobUrls.get(path);
    if (existing) return existing;
    if (visiting.has(path)) throw new Error(`import cycle through ${path}`);
    const file = byPath.get(path);
    if (!file) throw new Error(`missing module ${path}`);
    visiting.add(path);

    let contents = file.contents;
    for (const spec of importsOf(contents)) {
      const target = resolvePath(path, spec);
      const url = build(target);
      // Replace the exact quoted specifier with the dependency's blob URL.
      contents = contents.split(`"${spec}"`).join(`"${url}"`).split(`'${spec}'`).join(`'${url}'`);
    }
    visiting.delete(path);
    const url = URL.createObjectURL(new Blob([contents], { type: "text/javascript" }));
    blobUrls.set(path, url);
    created.push(url);
    return url;
  };

  for (const f of files) build(f.path);
  const picked = pickEntry(files);
  return { entry: picked ? blobUrls.get(picked.path)! : null, kind: picked?.kind ?? "compose", urls: created };
}

// The Worker bootstrap (a classic script, instantiated from a blob): imports the linked
// entry, instantiates the composition root (or, with no capabilities, the context's own
// surface), invokes the single zero-argument
// service handler, and reports captured logs + the returned value. Console output
// (the `Logger` provider) is intercepted in-Worker.
// Each log line is posted as it is written, not held until the end, so a run that times
// out still reports what it logged before it hung (#28). The final message has `done`.
const WORKER_SRC = `
const fmt = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
const log = (level, a) => self.postMessage({ log: { level, message: a.map(fmt).join(" ") } });
console.log = (...a) => log("info", a);
console.info = console.log;
console.error = (...a) => log("error", a);
console.warn = console.error;
self.onmessage = async (e) => {
  const { entryUrl, kind } = e.data;
  try {
    const mod = await import(entryUrl);
    // A program with capabilities enters through compose.js; one without has no
    // composition root, and its context module exports the surface directly (entry.ts).
    const make = kind === "surface" ? () => ({ context: mod.__makeSurface({}) }) : mod.composeApp;
    if (typeof make !== "function") {
      self.postMessage({ done: true, noEntry: true });
      return;
    }
    const app = make();
    let invoked = false, value;
    for (const ctxKey of Object.keys(app)) {
      const surface = app[ctxKey];
      if (!surface || typeof surface !== "object") continue;
      for (const m of Object.keys(surface)) {
        const fn = surface[m];
        if (typeof fn === "function" && fn.length === 0) {
          invoked = true;
          value = await fn();
          break;
        }
      }
      if (invoked) break;
    }
    if (!invoked) { self.postMessage({ done: true, noEntry: true }); return; }
    self.postMessage({ done: true, value: value === undefined ? undefined : fmt(value) });
  } catch (err) {
    self.postMessage({ done: true, error: String((err && err.stack) || err) });
  }
};
`;

// A run keeps at most this many log lines, so one that logs in a loop until its timeout
// cannot exhaust memory here or in the app.
const MAX_LOGS = 1000;

// The private channel from the app, handed over once in answer to "ready" (#30). Runs
// arrive and results leave only over it, never as window messages.
let port: MessagePort | null = null;

function reply(msg: RunReply): void {
  port?.postMessage(msg);
}

// The run in progress. A new run stops it: the app shows only the newest outcome, so a
// superseded Worker would only burn CPU until its timeout (#22).
let stopActive: (() => void) | null = null;

function run(req: RunRequest): void {
  stopActive?.();
  stopActive = null;
  let entry: string | null;
  let kind: EntryKind = "compose";
  let urls: string[] = [];
  try {
    const linked = linkGraph(req.files);
    entry = linked.entry;
    kind = linked.kind;
    urls = linked.urls;
  } catch (err) {
    reply({ kind: "bynk-result", id: req.id, logs: [], error: `link error: ${String(err)}` });
    return;
  }
  if (!entry) {
    reply({ kind: "bynk-result", id: req.id, logs: [], noEntry: true });
    return;
  }

  const workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
  // A classic Worker, not `{ type: "module" }`: Chromium refuses to start a module
  // Worker from a blob URL created in this opaque-origin document (onerror, no
  // message), so Run always failed with "worker error". A classic Worker's dynamic
  // `import()` of the blob-URL graph works, and the bootstrap has no top-level
  // module syntax.
  const worker = new Worker(workerUrl);
  let settled = false;
  const logs: RunReply["logs"] = [];
  let dropped = 0;
  const collected = (): RunReply["logs"] =>
    dropped === 0
      ? logs
      : [...logs, { level: "info", message: `… ${dropped} more log line${dropped === 1 ? "" : "s"} not shown` }];
  const cleanup = () => {
    urls.forEach(URL.revokeObjectURL);
    URL.revokeObjectURL(workerUrl);
    if (stopActive === stop) stopActive = null;
  };
  const stop = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker.terminate();
    cleanup();
    reply({ kind: "bynk-result", id: req.id, logs: [], superseded: true });
  };

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    worker.terminate();
    cleanup();
    reply({ kind: "bynk-result", id: req.id, logs: collected(), timedOut: true });
  }, req.timeoutMs);

  worker.onmessage = (e: MessageEvent) => {
    if (settled) return;
    const d = e.data as {
      log?: { level: string; message: unknown };
      done?: boolean;
      value?: string;
      error?: string;
      noEntry?: boolean;
    };
    if (d.log) {
      if (logs.length < MAX_LOGS) {
        logs.push({ level: d.log.level === "error" ? "error" : "info", message: String(d.log.message) });
      } else {
        dropped++;
      }
      return;
    }
    if (!d.done) return;
    settled = true;
    clearTimeout(timer);
    worker.terminate();
    cleanup();
    reply({
      kind: "bynk-result",
      id: req.id,
      logs: collected(),
      value: d.value,
      error: d.error,
      noEntry: d.noEntry,
    });
  };
  worker.onerror = (e: ErrorEvent) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker.terminate();
    cleanup();
    reply({ kind: "bynk-result", id: req.id, logs: collected(), error: e.message || "worker error" });
  };

  stopActive = stop;
  worker.postMessage({ entryUrl: entry, kind });
}

window.addEventListener("message", (e: MessageEvent) => {
  // Only ever take the channel from the app origin, and only once.
  if (e.origin !== APP_ORIGIN || port) return;
  const data = e.data as SandboxConnect;
  if (data?.kind !== "bynk-connect" || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = (m: MessageEvent) => {
    const req = m.data as RunRequest;
    if (req?.kind === "bynk-run") run(req);
  };
});

// Announce readiness so the app doesn't race the iframe load.
parent.postMessage({ kind: "bynk-sandbox-ready" }, APP_ORIGIN);
