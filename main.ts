import { serveDir } from "jsr:@std/http@1.0.0/file-server";

// 存储所有已连接的 WebSocket 客户端
const clients = new Set<WebSocket>();

// 广播消息给所有客户端
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

  // 1. 动态处理：WebSocket 升级请求
  if (pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expects WebSocket", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      clients.add(socket);
      console.log(`客户端连接，当前在线: ${clients.size}`);
    };
    socket.onclose = () => {
      clients.delete(socket);
      console.log(`客户端断开，当前在线: ${clients.size}`);
    };
    socket.onmessage = (event) => {
      broadcast(event.data); // 将收到的消息广播给所有客户端
    };
    return response;
  }

  // 2. 自动补全：处理无后缀的路径（如 /mrbt 自动映射到 /mrbt.html）
  if (pathname !== "/" && !pathname.includes(".")) {
    try {
      const htmlPath = "." + pathname + ".html";
      const stat = await Deno.stat(htmlPath);
      if (stat.isFile) {
        url.pathname = pathname + ".html";
      }
    } catch (_e) {
      // 找不到对应的 .html 文件，忽略，继续走 serveDir 的逻辑
    }
  }

  // 3. 静态文件服务（作为默认回退）
  return serveDir(new Request(url, req), {
    fsRoot: ".",
    urlRoot: "",
    showDirListing: false,
    quiet: true,
  });
});
