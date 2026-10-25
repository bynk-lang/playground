// The sandbox origin's Worker. This origin exists only to serve the execution document
// that runs untrusted snippet code (sandbox.html + sandbox.js, ADR 0140). Its assets
// directory is the whole of dist/, so without this script the origin would also serve the
// editor, which loads but can never run anything here: the sandbox only accepts
// instructions from the app origin. So serve the four files the sandbox needs and send
// every other request, a person browsing to sandbox.bynk-lang.dev included, to the app.
const SERVED = new Set(["/sandbox.html", "/sandbox", "/sandbox.js", "/sandbox.js.map"]);

// The execution document's policy (#34), a backstop behind the Bynk runtime's own bans:
// it may run its own script and the blob: modules it links a program into, and nothing
// else, and no code in it, the program's Worker included (a blob: Worker inherits this
// policy), can reach the network. The origin is named because a sandboxed document's
// origin is opaque, so 'self' may not match it. No frame-ancestors: an embedded
// playground puts this document inside third-party pages.
export function policy(origin) {
  return [
    "default-src 'none'",
    `script-src ${origin} blob:`,
    "worker-src blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (SERVED.has(url.pathname)) {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      if ((headers.get("content-type") ?? "").startsWith("text/html")) {
        headers.set("content-security-policy", policy(url.origin));
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    // Path and query carry over, so a share link opened on the wrong host still lands.
    // Set them on the app URL rather than resolving the path against it: a path that
    // starts `//` (or `/\`) would otherwise resolve to another host, an open redirect.
    const to = new URL(env.APP_ORIGIN);
    to.pathname = url.pathname;
    to.search = url.search;
    return Response.redirect(to.toString(), 302);
  },
};
