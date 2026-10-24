import { serveDir } from "jsr:@std/http@1.0.0/file-server";

// 初始化 Deno KV 数据库
const kv = await Deno.openKv();
// 管理密码（你可以改成自己想要的密码）
const ADMIN_PASSWORD = "mgdz_admin_2026";
// WebSocket 客户端集合
const clients = new Set<WebSocket>();

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

  // 获取真实用户 IP 用于防刷
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";

  // 1. WebSocket 连接
  if (pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expects WebSocket", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => clients.add(socket);
    socket.onclose = () => clients.delete(socket);
    return response;
  }

  // 2. 工单系统 API 路由
  if (pathname.startsWith("/api/tickets")) {
    
    // 获取所有工单
    if (pathname === "/api/tickets" && req.method === "GET") {
      const entries = kv.list({ prefix: ["tickets"] });
      const tickets = [];
      for await (const entry of entries) {
        tickets.push(entry.value);
      }
      // 按时间倒序排列（最新的在最前面）
      tickets.sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify(tickets), {
        headers: { "content-type": "application/json" }
      });
    }

    // 发布新工单
    if (pathname === "/api/tickets" && req.method === "POST") {
      // 防刷检查：同一 IP 一分钟只能发一条
      const rateLimitKey = ["ratelimit", ip];
      const rateLimit = await kv.get(rateLimitKey);
      if (rateLimit.value) {
        return new Response(JSON.stringify({ error: "提交太频繁，请一分钟后再试" }), {
          status: 429, headers: { "content-type": "application/json" }
        });
      }

      const body = await req.json();
      if (!body.type || !body.content) {
        return new Response(JSON.stringify({ error: "参数不完整" }), { status: 400 });
      }

      const ticket = {
        id: crypto.randomUUID(),
        type: body.type, // "bug" 或 "content"
        content: body.content.substring(0, 500), // 限制最多 500 字
        status: "待处理", // 默认状态
        ip: ip,
        createdAt: Date.now()
      };

      // 存入数据库
      await kv.set(["tickets", ticket.id], ticket);
      // 设置一分钟（60000ms）的防刷锁
      await kv.set(rateLimitKey, true, { expireIn: 60000 });

      // 广播通知所有在线用户刷新列表
      broadcast(JSON.stringify({ type: "update_tickets" }));
      
      return new Response(JSON.stringify({ success: true, ticket }), {
        headers: { "content-type": "application/json" }
      });
    }

    // 修改工单状态（管理员）
    if (pathname === "/api/tickets/status" && req.method === "POST") {
      const body = await req.json();
      
      if (body.password !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "管理密码错误" }), { status: 401 });
      }

      const ticketData = await kv.get(["tickets", body.id]);
      if (!ticketData.value) {
        return new Response(JSON.stringify({ error: "工单不存在" }), { status: 404 });
      }

      const updatedTicket = { ...ticketData.value, status: body.status };
      await kv.set(["tickets", body.id], updatedTicket);

      broadcast(JSON.stringify({ type: "update_tickets" }));
      return new Response(JSON.stringify({ success: true }), {
        headers: { "content-type": "application/json" }
      });
    }
  }

  // 3. 自动补全 HTML 后缀
  if (pathname !== "/" && !pathname.includes(".")) {
    try {
      const htmlPath = "." + pathname + ".html";
      const stat = await Deno.stat(htmlPath);
      if (stat.isFile) {
        url.pathname = pathname + ".html";
      }
    } catch (_e) {}
  }

  // 4. 静态文件服务
  const response = await serveDir(new Request(url, req), {
    fsRoot: ".", urlRoot: "", showDirListing: false, quiet: true,
  });

  // 5. 404 处理
  if (response.status === 404) {
    try {
      const notFoundPage = await Deno.readTextFile("./404.html");
      return new Response(notFoundPage, {
        status: 404, headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (_e) { return response; }
  }

  return response;
});
