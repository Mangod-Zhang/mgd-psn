import { serveDir } from "jsr:@std/http@1.0.0/file-server";

const kv = await Deno.openKv();
const clients = new Set<WebSocket>();

async function checkPassword(pass: string) {
  const msgUint8 = new TextEncoder().encode(pass);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  const dbHash = await kv.get(["admin", "hash"]);
  if (!dbHash.value) {
    await kv.set(["admin", "hash"], hashHex);
    return true;
  }
  return hashHex === dbHash.value;
}

function broadcast(message: string) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";

  if (pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expects WebSocket", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => clients.add(socket);
    socket.onclose = () => clients.delete(socket);
    return response;
  }

  if (pathname.startsWith("/api")) {
    // 新增：真正的密码验证接口
    if (pathname === "/api/auth" && req.method === "POST") {
      const body = await req.json();
      if (await checkPassword(body.password)) {
        return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "密码错误" }), { status: 401, headers: { "content-type": "application/json" } });
    }

    if (pathname === "/api/tickets" && req.method === "GET") {
      const entries = kv.list({ prefix: ["tickets"] });
      const tickets = [];
      for await (const entry of entries) {
        tickets.push(entry.value);
      }
      tickets.sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify(tickets), { headers: { "content-type": "application/json" } });
    }

    if (pathname === "/api/tickets" && req.method === "POST") {
      const rateLimitKey = ["ratelimit", ip];
      const rateLimit = await kv.get(rateLimitKey);
      if (rateLimit.value) {
        return new Response(JSON.stringify({ error: "提交太频繁，请一分钟后再试" }), { status: 429, headers: { "content-type": "application/json" } });
      }

      const body = await req.json();
      if (!body.type || !body.content) {
        return new Response(JSON.stringify({ error: "参数不完整" }), { status: 400 });
      }

      const ticket = {
        id: crypto.randomUUID(),
        type: body.type,
        content: body.content.substring(0, 500),
        status: "待处理",
        ip: ip,
        createdAt: Date.now()
      };

      await kv.set(["tickets", ticket.id], ticket);
      await kv.set(rateLimitKey, true, { expireIn: 60000 });
      broadcast(JSON.stringify({ type: "update_tickets" }));
      
      return new Response(JSON.stringify({ success: true, ticket }), { headers: { "content-type": "application/json" } });
    }

    if (pathname === "/api/tickets/status" && req.method === "POST") {
      const body = await req.json();
      if (!(await checkPassword(body.password))) {
        return new Response(JSON.stringify({ error: "管理密码错误" }), { status: 401, headers: { "content-type": "application/json" } });
      }

      const ticketData = await kv.get(["tickets", body.id]);
      if (!ticketData.value) {
        return new Response(JSON.stringify({ error: "工单不存在" }), { status: 404, headers: { "content-type": "application/json" } });
      }

      const updatedTicket = { ...ticketData.value, status: body.status };
      await kv.set(["tickets", body.id], updatedTicket);
      broadcast(JSON.stringify({ type: "update_tickets" }));
      return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
    }

    if (pathname === "/api/tickets/delete" && req.method === "POST") {
      const body = await req.json();
      if (!(await checkPassword(body.password))) {
        return new Response(JSON.stringify({ error: "管理密码错误" }), { status: 401, headers: { "content-type": "application/json" } });
      }

      await kv.delete(["tickets", body.id]);
      broadcast(JSON.stringify({ type: "update_tickets" }));
      return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (pathname !== "/" && !pathname.includes(".")) {
    try {
      const htmlPath = "." + pathname + ".html";
      const stat = await Deno.stat(htmlPath);
      if (stat.isFile) {
        url.pathname = pathname + ".html";
      }
    } catch (_e) {}
  }

  const response = await serveDir(new Request(url, req), {
    fsRoot: ".", urlRoot: "", showDirListing: false, quiet: true,
  });

  if (response.status === 404) {
    try {
      const notFoundPage = await Deno.readTextFile("./404.html");
      return new Response(notFoundPage, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (_e) { return response; }
  }

  return response;
});
