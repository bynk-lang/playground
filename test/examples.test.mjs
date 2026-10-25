// The gallery's promise (src/examples.ts): every example compiles and runs in the
// in-process subset. Checked against the staged compiler in src/vendor/ (the
// release in BYNK_VERSION, or the one the canary dispatched), so a Bynk release
// that breaks an example fails here rather than on someone's Run.
//
// Each example is compiled with `bynk_compile`, exactly as the app does, and its
// module graph written to a temporary directory and run the way the sandbox Worker
// runs it (test/run-helper.mjs, which shares src/entry.ts): enter through compose.js,
// or through the context's own surface when it has no capabilities, and call the one
// zero-argument handler. Needs `npm run fetch:assets` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { runSource } from "./run-helper.mjs";

const source = await readFile(new URL("../src/examples.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { EXAMPLES } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("the gallery is not empty", () => {
  assert.ok(EXAMPLES.length > 0);
});

for (const example of EXAMPLES) {
  test(`example "${example.id}" compiles and runs`, async () => {
    const r = await runSource(example.source, example.id);
    assert.ok(r.ok, `does not compile:\n${r.errors.join("\n")}`);
    assert.ok(!r.noEntry, "no zero-argument handler to run");
    assert.equal(r.error, undefined, `the handler threw: ${r.error}`);
  });
}
