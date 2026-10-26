// The Compiled JS tab's grouping (src/jsview.ts, #14) against the real compiler: the
// program's own modules lead, the composition root and the runtime are set aside, and
// every emitted file lands in exactly one group, so nothing the sandbox runs is hidden
// beyond reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const vendor = new URL("../src/vendor/", import.meta.url);
const { default: init, bynk_compile } = await import(new URL("bynk_wasm.js", vendor));
await init({ module_or_path: await readFile(new URL("bynk_wasm_bg.wasm", vendor)) });
const load = async (path) => {
  const { code } = await transform(await readFile(new URL(path, import.meta.url), "utf8"), { loader: "ts", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
};
const { groupFiles, kindOf, lineCount } = await load("../src/jsview.ts");
const { EXAMPLES } = await load("../src/examples.ts");

const compile = (source) => {
  const result = JSON.parse(bynk_compile(source));
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result.files;
};
const paths = (files) => files.map((f) => f.path);

test("hello leads with its own module, about 15 lines", () => {
  const files = compile(EXAMPLES.find((e) => e.id === "hello").source);
  const view = groupFiles(files);
  assert.deepEqual(paths(view.user), ["hello/world.js"]);
  assert.deepEqual(paths(view.wiring), ["compose.js"]);
  assert.ok(view.support.some((f) => f.path.startsWith("__bynk_runtime/")), paths(view.support).join(", "));
  assert.ok(lineCount(view.user) <= 30, `user code is ${lineCount(view.user)} lines`);
  assert.ok(lineCount(view.support) > 10 * lineCount(view.user));
});

test("every example's files are all grouped, each exactly once", () => {
  for (const ex of EXAMPLES) {
    const files = compile(ex.source);
    const view = groupFiles(files);
    assert.equal(view.user.length + view.wiring.length + view.support.length, files.length, ex.id);
    assert.ok(view.user.length > 0, `${ex.id} shows no code of its own`);
  }
});

test("a capability-free context named compose is the program's own code", () => {
  const files = compile(`context compose

service make {
  on call() -> Effect[Int] { 42 }
}
`);
  const own = files.find((f) => f.path === "compose.js");
  assert.ok(own, paths(files).join(", "));
  assert.equal(kindOf(own), "user");
});

test("the compiler's own kind wins over the path", () => {
  assert.equal(kindOf({ path: "__bynk_runtime/result.js", contents: "", kind: "user" }), "user");
  assert.equal(kindOf({ path: "app/main.js", contents: "", kind: "support" }), "support");
  assert.equal(kindOf({ path: "bynk/logger.js", contents: "" }), "support");
});

test("lines are counted without a trailing newline", () => {
  assert.equal(lineCount([{ path: "a.js", contents: "a\nb\n" }, { path: "b.js", contents: "c" }]), 3);
});
