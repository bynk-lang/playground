// The tour's promise (src/tour.ts): each step's starter fails its own check and its
// solution passes it, through the staged compiler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { runSource } from "./run-helper.mjs";

const source = await readFile(new URL("../src/tour.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { TOUR, nextIncomplete } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const outcome = (r) => ({ compiled: r.ok, value: r.value, error: r.error });

test("the tour has steps with unique ids", () => {
  assert.ok(TOUR.length > 0);
  assert.equal(new Set(TOUR.map((s) => s.id)).size, TOUR.length);
});

test("the tour opens at the first step not yet done", () => {
  const ids = ["a", "b", "c"];
  assert.equal(nextIncomplete(ids, []), 0);
  assert.equal(nextIncomplete(ids, ["a"]), 1);
  assert.equal(nextIncomplete(ids, ["a", "c"]), 1);
});

test("a finished tour opens at the start again", () => {
  assert.equal(nextIncomplete(["a", "b"], ["a", "b"]), 0);
});

for (const step of TOUR) {
  test(`tour step "${step.id}": the starter is not yet done`, async () => {
    const r = await runSource(step.starter, step.id);
    assert.notEqual(step.check(outcome(r)), null, "the starter already passes its check");
  });
  test(`tour step "${step.id}": the solution passes`, async () => {
    const r = await runSource(step.solution, step.id);
    assert.deepEqual(r.errors, [], "the solution does not compile");
    assert.equal(step.check(outcome(r)), null);
  });
}
