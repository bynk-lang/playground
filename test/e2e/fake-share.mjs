// A stand-in share Worker for the Workers tests: the service the app Worker binds as
// `snippets`, with the same two routes and answers as share/ (in memory).
const store = new Map();
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/snippets") {
      const { source } = await request.json();
      const id = `w${store.size + 1}`;
      store.set(id, source);
      return Response.json({ id }, { status: 201 });
    }
    const id = url.pathname.split("/").pop();
    return request.method === "GET" && store.has(id)
      ? Response.json({ source: store.get(id) })
      : new Response(null, { status: 404 });
  },
};
