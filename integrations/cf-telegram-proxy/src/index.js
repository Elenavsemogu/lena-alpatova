/**
 * Proxy: Amvera → Cloudflare → api.telegram.org
 *
 * Секрет: в Cloudflare Worker → Settings → Variables →
 *   PROXY_SECRET = (тот же TELEGRAM_PROXY_SECRET на Amvera)
 * Заголовок: X-Tg-Proxy-Secret
 */
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const incoming = new URL(request.url);
    if (incoming.pathname === "/" || incoming.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    const expected = (env && env.PROXY_SECRET) || "";
    if (expected) {
      const got = request.headers.get("X-Tg-Proxy-Secret") || "";
      if (got !== expected) {
        return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }

    if (!incoming.pathname.startsWith("/bot") && !incoming.pathname.startsWith("/file/bot")) {
      return new Response("Not found", { status: 404 });
    }

    const target = `https://api.telegram.org${incoming.pathname}${incoming.search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("x-forwarded-proto");
    headers.delete("x-forwarded-for");
    headers.delete("x-tg-proxy-secret");

    const init = {
      method: request.method,
      headers,
      redirect: "follow",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    try {
      const upstream = await fetch(target, init);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          ok: false,
          description: `Proxy error: ${err && err.message ? err.message : String(err)}`,
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
  },
};
