// The app Worker (worker/app.mjs) and the config merge (scripts/with-share-binding.mjs):
// /api/* goes to the SHARE binding when present and answers 503 when not, everything
// else goes to the assets, and the generated config adds exactly one binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../worker/app.mjs";
import sandbox from "../worker/sandbox.mjs";
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

const sandboxEnv = { ASSETS: tag("assets"), APP_ORIGIN: "https://app.example" };
const sandboxReq = (path) => new Request(`https://sandbox.example${path}`);

test("the execution document is served under a policy that allows no network access", async () => {
  const html = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) };
  const res = await sandbox.fetch(sandboxReq("/sandbox"), { ...sandboxEnv, ASSETS: html });
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src https:\/\/sandbox\.example blob:/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /frame-ancestors/, "an embedded playground must still load it");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const js = { fetch: async () => new Response("", { headers: { "content-type": "text/javascript" } }) };
  const script = await sandbox.fetch(sandboxReq("/sandbox.js"), { ...sandboxEnv, ASSETS: js });
  assert.equal(script.headers.get("content-security-policy"), null, "the policy belongs to the document");
  assert.equal(script.headers.get("x-content-type-options"), "nosniff");
});

test("the sandbox origin serves only the execution document", async () => {
  for (const path of ["/sandbox.html", "/sandbox", "/sandbox.js", "/sandbox.js.map"]) {
    const res = await sandbox.fetch(sandboxReq(path), sandboxEnv);
    assert.equal(await res.text(), `assets:${path}`, path);
  }
});

test("anything else on the sandbox origin is sent to the app, path and query kept", async () => {
  for (const [path, location] of [
    ["/", "https://app.example/"],
    ["/index.html", "https://app.example/index.html"],
    ["/app.js", "https://app.example/app.js"],
    ["/?s=abc123", "https://app.example/?s=abc123"],
    ["/api/snippets", "https://app.example/api/snippets"],
    // A path that looks scheme-relative stays on the app origin (no open redirect).
    ["//evil.example/", "https://app.example//evil.example/"],
    ["/\\evil.example/", "https://app.example//evil.example/"],
    ["//evil.example/%2e%2e", "https://app.example//"],
  ]) {
    const res = await sandbox.fetch(sandboxReq(path), sandboxEnv);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("location"), location, path);
  }
});

// A stand-in for the rate-limiting binding: allows `allowed` calls, then refuses.
const limiter = (allowed) => {
  const calls = [];
  return { calls, limit: async ({ key }) => (calls.push(key), { success: calls.length <= allowed }) };
};
const post = (path, ip) =>
  new Request(`https://playground.example${path}`, { method: "POST", headers: ip ? { "cf-connecting-ip": ip } : {} });

test("creating a snippet is rate limited per client address, then answers 429 with Retry-After", async () => {
  const SHARE_LIMIT = limiter(2);
  const env = { SHARE: tag("share"), ASSETS: tag("assets"), SHARE_LIMIT };
  assert.equal(await (await worker.fetch(post("/api/snippets", "203.0.113.7"), env)).text(), "share:/api/snippets");
  assert.equal(await (await worker.fetch(post("/api/snippets", "203.0.113.7"), env)).text(), "share:/api/snippets");
  const blocked = await worker.fetch(post("/api/snippets", "203.0.113.7"), env);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.match((await blocked.json()).error, /too many shares/);
  assert.deepEqual(SHARE_LIMIT.calls, ["203.0.113.7", "203.0.113.7", "203.0.113.7"], "keyed by cf-connecting-ip");
});

test("reads and other paths are never rate limited", async () => {
  const SHARE_LIMIT = limiter(0);
  const env = { SHARE: tag("share"), ASSETS: tag("assets"), SHARE_LIMIT };
  assert.equal(await (await worker.fetch(req("/api/snippets/abc123"), env)).text(), "share:/api/snippets/abc123");
  assert.equal(await (await worker.fetch(post("/api/other", "203.0.113.7"), env)).text(), "share:/api/other");
  assert.deepEqual(SHARE_LIMIT.calls, []);
});

test("without the binding (local runs, tests) nothing is limited", async () => {
  const res = await worker.fetch(post("/api/snippets", "203.0.113.7"), { SHARE: tag("share"), ASSETS: tag("assets") });
  assert.equal(await res.text(), "share:/api/snippets");
});

test("a POST with no address header is limited under one shared key rather than skipped", async () => {
  const SHARE_LIMIT = limiter(5);
  await worker.fetch(post("/api/snippets"), { SHARE: tag("share"), ASSETS: tag("assets"), SHARE_LIMIT });
  assert.deepEqual(SHARE_LIMIT.calls, ["unknown"]);
});

test("the wrangler config declares the SHARE_LIMIT binding the Worker uses", async () => {
  const jsonc = await readFile(new URL("../wrangler.app.jsonc", import.meta.url), "utf8");
  const [limit] = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, "")).ratelimits;
  assert.equal(limit.name, "SHARE_LIMIT");
  assert.deepEqual(limit.simple, { limit: 10, period: 60 });
});
