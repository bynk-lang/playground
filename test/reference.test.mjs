// The standard library reference (src/reference.ts), harvested from the staged compiler's
// completion: what a newcomer looks for is there, with its signature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const vendor = new URL("../src/vendor/", import.meta.url);
const { default: init, bynk_complete } = await import(new URL("bynk_wasm.js", vendor));
await init({ module_or_path: await readFile(new URL("bynk_wasm_bg.wasm", vendor)) });

const source = await readFile(new URL("../src/reference.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { harvestReference, searchReference, EXTRA_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const complete = (src, offset) => JSON.parse(bynk_complete(src, offset)).items;
const groups = harvestReference(complete);
const entry = (name) => groups.flatMap((g) => g.entries).find((e) => e.name === name);

test("the reference has types, capabilities and modules", () => {
  for (const section of ["Types", "Capabilities", "Modules"]) assert.ok(groups.some((g) => g.section === section), section);
});

test("how to parse an Int, found by searching", () => {
  assert.equal(entry("Int.parse")?.signature, "parse(s: String) -> Option[Int]");
  const found = searchReference(groups, "parse int").flatMap((g) => g.entries.map((e) => e.name));
  assert.ok(found.includes("Int.parse"), found.join(", "));
});

test("capability operations come with their signatures, without the compiler's suffix", () => {
  assert.equal(entry("Logger.info")?.signature, "info(msg: String) -> Effect[()]");
  assert.equal(entry("Clock.now")?.signature, "now() -> Effect[Instant]");
  for (const cap of ["Logger", "Clock", "Random"]) {
    const g = groups.find((x) => x.section === "Capabilities" && x.owner === cap);
    assert.ok(g && g.entries.length > 0, cap);
  }
});

test("module functions are listed under their module", () => {
  const list = groups.find((g) => g.section === "Modules" && g.owner === "bynk.string");
  assert.ok(list?.entries.some((e) => e.name === "join"));
});

test("each type listed by hand still has functions", () => {
  for (const t of EXTRA_TYPES) {
    const g = groups.find((x) => x.section === "Types" && x.owner === t);
    assert.ok(g && g.entries.length > 0, `${t} has no functions in this release`);
  }
});

test("search matches every word, and a group by its name", () => {
  const g = [
    { section: "Types", owner: "Int", about: "The integer base type.", entries: [{ name: "Int.parse", signature: "parse(s: String) -> Option[Int]" }] },
    { section: "Types", owner: "Bool", about: "The boolean base type.", entries: [] },
  ];
  assert.deepEqual(searchReference(g, "").length, 2);
  assert.deepEqual(searchReference(g, "PARSE  int").map((x) => x.owner), ["Int"]);
  assert.deepEqual(searchReference(g, "parse bool"), []);
  assert.deepEqual(searchReference(g, "boolean"), [{ ...g[1], entries: [] }]);
});
