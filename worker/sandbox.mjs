// The sandbox origin's Worker. This origin exists only to serve the execution document
// that runs untrusted snippet code (sandbox.html + sandbox.js, ADR 0140). Its assets
// directory is the whole of dist/, so without this script the origin would also serve the
// editor, which loads but can never run anything here: the sandbox only accepts
// instructions from the app origin. So serve the four files the sandbox needs and send
// every other request, a person browsing to sandbox.bynk-lang.dev included, to the app.
const SERVED = new Set(["/sandbox.html", "/sandbox", "/sandbox.js", "/sandbox.js.map"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (SERVED.has(url.pathname)) return env.ASSETS.fetch(request);
    // Path and query carry over, so a share link opened on the wrong host still lands.
    return Response.redirect(new URL(url.pathname + url.search, env.APP_ORIGIN).toString(), 302);
  },
};
