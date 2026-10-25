// The app origin's Worker. The static app is served by the assets binding; this script
// runs first only for `/api/*` (wrangler.app.jsonc `run_worker_first`) and hands those
// calls to the share service through the `SHARE` service binding, so the browser keeps
// calling the app origin same-origin: Bynk's `from http` emits no CORS headers.
//
// `SHARE` is bound only when the share service was deployed in the same run (see
// scripts/with-share-binding.mjs and ci.yml). Without it every `/api/*` call answers
// 503, which the app already treats as "no share service": it falls back to the
// self-contained `#…` link.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      if (!env.SHARE) {
        return Response.json({ error: "share service not available" }, { status: 503 });
      }
      return env.SHARE.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
