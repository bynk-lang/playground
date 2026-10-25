// Write wrangler.app.share.jsonc: wrangler.app.jsonc plus the `SHARE` service binding to
// the share Worker (`snippets`, the name `bynk deploy` gives the share context).
//
// Cloudflare refuses an upload that binds to a Worker that does not exist, so the
// binding is added only in a run where the share service was just deployed (ci.yml).
// The file is written beside the original so its relative paths still resolve.
import { readFileSync, writeFileSync } from "node:fs";

const SHARE_WORKER = "snippets";

export function withShareBinding(jsonc) {
  // wrangler.app.jsonc has only whole-line `//` comments.
  const config = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ""));
  return { ...config, services: [...(config.services ?? []), { binding: "SHARE", service: SHARE_WORKER }] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = withShareBinding(readFileSync("wrangler.app.jsonc", "utf8"));
  writeFileSync("wrangler.app.share.jsonc", `${JSON.stringify(out, null, 2)}\n`);
  console.log("wrangler.app.share.jsonc");
}
