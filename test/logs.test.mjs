// The sandbox's log buffer (src/logs.ts): every line a run logs is kept up to MAX_LOGS,
// and the rest are counted, not kept, so a program that logs in a loop until its timeout
// cannot exhaust memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const { code } = await transform(await readFile(new URL("../src/logs.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
const { LogBuffer, MAX_LOGS } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("lines are kept in order, levels coerced to info or error", () => {
  const logs = new LogBuffer();
  logs.push("info", "one");
  logs.push("error", "two");
  logs.push("warn?", 3);
  assert.deepEqual(logs.collected(), [
    { level: "info", message: "one" },
    { level: "error", message: "two" },
    { level: "info", message: "3" },
  ]);
});

test("past the cap, lines are counted, not kept", () => {
  const logs = new LogBuffer();
  for (let i = 0; i < MAX_LOGS + 5; i++) logs.push("info", `line ${i}`);
  const out = logs.collected();
  assert.equal(out.length, MAX_LOGS + 1);
  assert.equal(out[MAX_LOGS - 1].message, `line ${MAX_LOGS - 1}`);
  assert.deepEqual(out[MAX_LOGS], { level: "info", message: "… 5 more log lines not shown" });
});

test("one dropped line is counted in the singular", () => {
  const logs = new LogBuffer();
  for (let i = 0; i <= MAX_LOGS; i++) logs.push("info", "x");
  assert.equal(logs.collected().at(-1).message, "… 1 more log line not shown");
});
