// Compile a Bynk source with the staged wasm compiler and run its one
// zero-argument handler the way the sandbox Worker does (src/sandbox.ts).
// Returns { ok, errors, logs, value, error } — the shape the tour's `check` reads.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const vendor = new URL("../src/vendor/", import.meta.url);
const { default: init, bynk_compile } = await import(new URL("bynk_wasm.js", vendor));
await init({ module_or_path: await readFile(new URL("bynk_wasm_bg.wasm", vendor)) });

// The sandbox's own entry choice (src/entry.ts), so the tests cannot drift from it.
const { code } = await transform(await readFile(new URL("../src/entry.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
const { pickEntry } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v));

export async function runSource(source, label = "run") {
  const result = JSON.parse(bynk_compile(source));
  const errors = result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.line}:${d.col} ${d.message}`);
  if (!result.ok) return { ok: false, errors, logs: [] };
  const dir = await mkdtemp(join(tmpdir(), `bynk-playground-${label}-`));
  try {
    for (const f of result.files) {
      await mkdir(dirname(join(dir, f.path)), { recursive: true });
      await writeFile(join(dir, f.path), f.contents);
    }
    const entry = pickEntry(result.files);
    if (!entry) return { ok: true, errors: [], logs: [], noEntry: true };
    const mod = await import(pathToFileURL(join(dir, entry.path)).href);
    // As the sandbox Worker does: compose.js for a program with capabilities, the
    // context module's own surface for one without.
    const app = entry.kind === "surface" ? { context: mod.__makeSurface({}) } : mod.composeApp();
    const entries = Object.values(app)
      .filter((surface) => surface && typeof surface === "object")
      .flatMap((surface) => Object.values(surface))
      .filter((fn) => typeof fn === "function" && fn.length === 0);
    if (entries.length === 0) return { ok: true, errors: [], logs: [], noEntry: true };
    const logs = [];
    const { log, info } = console;
    console.log = console.info = (...a) => logs.push(a.map(fmt).join(" "));
    try {
      const value = await entries[0]();
      return { ok: true, errors: [], logs, value: value === undefined ? undefined : fmt(value) };
    } catch (e) {
      return { ok: true, errors: [], logs, error: String(e) };
    } finally {
      console.log = log;
      console.info = info;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
