// The page's icons and link-preview tags: present, absolute where unfurlers need them,
// and pointing at files that exist in assets/ (which build.mjs copies into dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const meta = (key) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];

test("the link-preview tags are set, with an absolute image URL", () => {
  for (const key of ["og:title", "og:description", "og:url", "og:image", "og:image:alt", "twitter:card", "description"]) {
    assert.ok(meta(key), `${key} is missing`);
  }
  assert.match(meta("og:image"), /^https:\/\/playground\.bynk-lang\.dev\/og\.png$/);
  assert.equal(meta("twitter:card"), "summary_large_image");
});

test("every icon and image the page names exists in assets/", async () => {
  const names = [...html.matchAll(/(?:href|content)="(?:https:\/\/playground\.bynk-lang\.dev)?\/([\w.-]+\.(?:svg|png))"/g)].map((m) => m[1]);
  assert.ok(names.length >= 4, `expected the icons and og image, found ${names}`);
  for (const name of new Set(names)) await stat(new URL(`../assets/${name}`, import.meta.url));
});

test("og.png is a 1200x630 PNG", async () => {
  const png = await readFile(new URL("../assets/og.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
