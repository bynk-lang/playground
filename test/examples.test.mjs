// The gallery's promise (src/examples.ts): every example compiles and runs in the
// in-process subset. Checked against the staged compiler in src/vendor/ (the
// release in BYNK_VERSION, or the one the canary dispatched), so a Bynk release
// that breaks an example fails here rather than on someone's Run.
//
// Each example is compiled with `bynk_compile`, exactly as the app does, and its
// module graph written to a temporary directory and run the way the sandbox
// Worker runs it (src/sandbox.ts): instantiate `composeApp()`, call the one
// zero-argument handler. Needs `npm run fetch:assets` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const vendor = new URL("../src/vendor/", import.meta.url);
const { default: init, bynk_compile } = await import(new URL("bynk_wasm.js", vendor));
await init({ module_or_path: await readFile(new URL("bynk_wasm_bg.wasm", vendor)) });

const source = await readFile(new URL("../src/examples.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { EXAMPLES } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("the gallery is not empty", () => {
  assert.ok(EXAMPLES.length > 0);
});

for (const example of EXAMPLES) {
  test(`example "${example.id}" compiles and runs`, async () => {
    const result = JSON.parse(bynk_compile(example.source));
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    assert.ok(result.ok, `does not compile:\n${errors.map((d) => `${d.line}:${d.col} ${d.message}`).join("\n")}`);

    const dir = await mkdtemp(join(tmpdir(), `bynk-playground-${example.id}-`));
    try {
      for (const f of result.files) {
        await mkdir(dirname(join(dir, f.path)), { recursive: true });
        await writeFile(join(dir, f.path), f.contents);
      }
      const mod = await import(pathToFileURL(join(dir, "compose.js")).href);
      assert.equal(typeof mod.composeApp, "function", "the graph has no composeApp");

      const app = mod.composeApp();
      const entries = Object.values(app)
        .filter((surface) => surface && typeof surface === "object")
        .flatMap((surface) => Object.values(surface))
        .filter((fn) => typeof fn === "function" && fn.length === 0);
      assert.ok(entries.length > 0, "no zero-argument handler to run");

      // Logger writes to the console; keep the test output to the reporter's.
      const log = console.log;
      const info = console.info;
      console.log = console.info = () => {};
      try {
        await entries[0]();
      } finally {
        console.log = log;
        console.info = info;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
