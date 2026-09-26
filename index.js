const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// 开启socket.io，允许前端连接
const io = new Server(server);

// 托管静态文件：html、css、js全部直接访问
app.use(express.static('.'));

// --------socket.io示例事件，后期你可以删掉重写--------
io.on('connection', (socket) => {
  console.log('客户端已连接', socket.id);

  socket.on('chat', (msg) => {
    io.emit('chat', msg);
  });

  socket.on('disconnect', () => {
    console.log('客户端断开');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务运行，端口：${PORT}`);
});