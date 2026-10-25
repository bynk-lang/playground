// The sandbox's entry choice (src/entry.ts) against the real compiler: a program that
// consumes a capability enters through compose.js; one that consumes none has no
// compose.js and must still run. The second case is the bug where a capability-free
// program reported "No zero-argument service handler to run" despite having one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { runSource } from "./run-helper.mjs";

const vendor = new URL("../src/vendor/", import.meta.url);
const { default: init, bynk_compile } = await import(new URL("bynk_wasm.js", vendor));
await init({ module_or_path: await readFile(new URL("bynk_wasm_bg.wasm", vendor)) });
const { code } = await transform(await readFile(new URL("../src/entry.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
const { pickEntry } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

// The exact snippet that was reported.
const NO_CAPABILITY = `context demo.records

type Point = { x: Int, y: Int }

service make {
  on call() -> Effect[Point] {
    Point { x: 3, y: 4 }
  }
}
`;
const WITH_CAPABILITY = `context demo.records

consumes bynk { Logger }

type Point = { x: Int, y: Int }

service make {
  on call() -> Effect[Point] given Logger {
    Point { x: 3, y: 4 }
  }
}
`;
const NO_HANDLER = `context demo.types

type Point = { x: Int, y: Int }
`;

const compile = (src) => JSON.parse(bynk_compile(src));

test("a program with a capability enters through compose.js", () => {
  const r = compile(WITH_CAPABILITY);
  assert.deepEqual(pickEntry(r.files), { path: "compose.js", kind: "compose" });
});

test("a program with no capabilities has no compose.js and enters through its context module", () => {
  const r = compile(NO_CAPABILITY);
  assert.ok(r.ok);
  assert.ok(!r.files.some((f) => f.path === "compose.js"), "the compiler emits no composition root here");
  assert.deepEqual(pickEntry(r.files), { path: "demo/records.js", kind: "surface" });
});

test("both programs run and return the point", async () => {
  for (const [name, src] of [["no capability", NO_CAPABILITY], ["with Logger", WITH_CAPABILITY]]) {
    const r = await runSource(src, "entry");
    assert.ok(r.ok, `${name} compiles: ${r.errors}`);
    assert.ok(!r.noEntry, `${name} has a handler to run`);
    assert.equal(r.value, '{"x":3,"y":4}', name);
  }
});

test("a program with no service has nothing to run, and says so rather than failing", async () => {
  const r = await runSource(NO_HANDLER, "entry");
  assert.ok(r.ok);
  assert.equal(r.noEntry, true);
});
