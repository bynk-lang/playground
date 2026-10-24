// The pure part of src/store.ts: how the recent-snippets list is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { pushRecent } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("a new snippet goes to the front", () => {
  const list = pushRecent([{ src: "a", at: 1 }], "b", 2);
  assert.deepEqual(list.map((r) => r.src), ["b", "a"]);
});

test("running the same snippet again moves it up instead of duplicating it", () => {
  const list = pushRecent([{ src: "b", at: 2 }, { src: "a", at: 1 }], "a", 3);
  assert.deepEqual(list, [{ src: "a", at: 3 }, { src: "b", at: 2 }]);
});

test("the list is capped, dropping the oldest", () => {
  let list = [];
  for (let i = 0; i < 15; i++) list = pushRecent(list, `s${i}`, i);
  assert.equal(list.length, 10);
  assert.equal(list[0].src, "s14");
  assert.equal(list[9].src, "s5");
});
