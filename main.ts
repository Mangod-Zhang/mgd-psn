import { serveDir } from "https://deno.land/std/http/file_server.ts";

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

Deno.serve((req) => {
  const url = new URL(req.url);

  // WebSocket 升级请求
  if (url.pathname === "/ws") {
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
      // 将收到的消息广播给所有客户端
      broadcast(event.data);
    };
    return response;
  }

  // 静态文件服务（放在最后，作为默认回退）
  return serveDir(req, {
    fsRoot: ".",
    urlRoot: "",
    showDirListing: false,
    quiet: true,
  });
});
