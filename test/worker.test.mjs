// The app Worker (worker/app.mjs) and the config merge (scripts/with-share-binding.mjs):
// /api/* goes to the SHARE binding when present and answers 503 when not, everything
// else goes to the assets, and the generated config adds exactly one binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../worker/app.mjs";
import { withShareBinding } from "../scripts/with-share-binding.mjs";

const req = (path) => new Request(`https://playground.example${path}`);
const tag = (name) => ({ fetch: async (r) => new Response(`${name}:${new URL(r.url).pathname}`) });

test("API calls go to the share service when it is bound", async () => {
  const res = await worker.fetch(req("/api/snippets"), { SHARE: tag("share"), ASSETS: tag("assets") });
  assert.equal(await res.text(), "share:/api/snippets");
});

test("API calls answer 503 without the binding, so the app falls back to the hash link", async () => {
  const res = await worker.fetch(req("/api/snippets/abc123"), { ASSETS: tag("assets") });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "share service not available" });
});

test("everything else is served from the assets", async () => {
  const res = await worker.fetch(req("/app.js"), { SHARE: tag("share"), ASSETS: tag("assets") });
  assert.equal(await res.text(), "assets:/app.js");
});

test("the merged wrangler config adds the SHARE binding and keeps the rest", async () => {
  const jsonc = await readFile(new URL("../wrangler.app.jsonc", import.meta.url), "utf8");
  const base = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ""));
  const merged = withShareBinding(jsonc);
  assert.deepEqual(merged.services, [{ binding: "SHARE", service: "snippets" }]);
  assert.deepEqual({ ...merged, services: undefined }, { ...base, services: undefined });
  assert.equal(base.services, undefined, "the base config binds nothing");
});
