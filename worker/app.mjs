// The app origin's Worker. The static app is served by the assets binding; this script
// runs first only for `/api/*` (wrangler.app.jsonc `run_worker_first`) and hands those
// calls to the share service through the `SHARE` service binding, so the browser keeps
// calling the app origin same-origin: Bynk's `from http` emits no CORS headers.
//
// `SHARE` is bound only when the share service was deployed in the same run (see
// scripts/with-share-binding.mjs and ci.yml). Without it every `/api/*` call answers
// 503, which the app already treats as "no share service": it falls back to the
// self-contained `#…` link. A rate-limited POST answers 429 and falls back the same way.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      if (!env.SHARE) {
        return Response.json({ error: "share service not available" }, { status: 503 });
      }
      // Creating a snippet writes to KV, so limit how fast one client can do it (the
      // SHARE_LIMIT rate-limiting binding in wrangler.app.jsonc). Reads are not limited.
      // Cloudflare sets cf-connecting-ip itself, so a caller cannot choose the key.
      if (request.method === "POST" && pathname === "/api/snippets" && env.SHARE_LIMIT) {
        const key = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.SHARE_LIMIT.limit({ key });
        if (!success) {
          // The app treats any failed share as "no short link" and falls back to #… .
          return Response.json(
            { error: "too many shares from this address; try again in a minute" },
            { status: 429, headers: { "retry-after": "60" } },
          );
        }
      }
      return env.SHARE.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
