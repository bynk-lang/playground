// Every example and every tour source is already in the house style: `bynk_format` (the
// compiler's own formatter, the same one the Format button calls) returns each unchanged.
// So pressing Format on a gallery example or a tour starter changes nothing, and a new
// example that is not formatted fails here instead of surprising the first person to
// press Format. Needs a release that exports bynk_format (v0.405.4 or later).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const vendor = new URL("../src/vendor/", import.meta.url);
const { default: init, bynk_format } = await import(new URL("bynk_wasm.js", vendor));
await init({ module_or_path: await readFile(new URL("bynk_wasm_bg.wasm", vendor)) });
const load = async (file) => {
  const { code } = await transform(await readFile(new URL(`../src/${file}`, import.meta.url), "utf8"), { loader: "ts", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
};
const { EXAMPLES } = await load("examples.ts");
const { TOUR } = await load("tour.ts");

const check = (label, source) =>
  test(`${label} is in the house style`, () => {
    const r = JSON.parse(bynk_format(source));
    assert.ok(r.ok, `does not parse: ${r.error}`);
    assert.equal(r.formatted, source, "run Format (or `bynk fmt`) on it");
  });

for (const e of EXAMPLES) check(`example "${e.id}"`, e.source);
for (const s of TOUR) {
  check(`tour step "${s.id}" starter`, s.starter);
  check(`tour step "${s.id}" solution`, s.solution);
}
