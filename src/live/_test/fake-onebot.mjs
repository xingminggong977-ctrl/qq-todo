// 自测用假 OneBot 11 WS server：只做握手校验、下发事件帧、按 echo 回动作响应，不参与生产逻辑。
import http from "node:http";
import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function createFakeOneBot({ requiredToken = "", onAction } = {}) {
  const sockets = new Set();
  const state = { authHeaders: [], accepted: 0, rejected: 0, acceptTimes: [], actions: [] };

  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });

  function sendTo(socket, payload) {
    socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(payload), "utf8")));
  }

  server.on("upgrade", (req, socket) => {
    state.authHeaders.push(req.headers.authorization ?? null);
    if (requiredToken && req.headers.authorization !== `Bearer ${requiredToken}`) {
      state.rejected += 1;
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    state.accepted += 1;
    state.acceptTimes.push(Date.now());
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    readFrames(socket, (payload) => {
      let frame;
      try {
        frame = JSON.parse(payload);
      } catch {
        return;
      }
      state.actions.push({ action: frame?.action, params: frame?.params ?? {} });
      const reply = typeof onAction === "function" ? onAction(frame) : null;
      if (reply) sendTo(socket, reply);
    });
  });

  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return this;
    },
    get url() {
      return `ws://127.0.0.1:${server.address().port}/`;
    },
    /** 向所有已连接客户端下发一条 JSON 文本帧 */
    send(payload) {
      const frame = encodeFrame(0x1, Buffer.from(JSON.stringify(payload), "utf8"));
      for (const socket of sockets) socket.write(frame);
      return sockets.size;
    },
    dropSockets() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async close() {
      this.dropSockets();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function waitFor(predicate, timeoutMs = 4000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = Boolean(predicate());
      } catch {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor 超时"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

export function watchCrash() {
  const crashes = [];
  process.on("uncaughtException", (err) => {
    crashes.push(`uncaughtException: ${err?.stack ?? err}`);
    console.log("FAIL 出现未捕获异常：", err?.message ?? err);
  });
  process.on("unhandledRejection", (err) => {
    crashes.push(`unhandledRejection: ${err?.stack ?? err}`);
    console.log("FAIL 出现未处理 rejection：", err?.message ?? err);
  });
  return crashes;
}

// 客户端帧一定是掩码的；按需累积缓冲、拆帧，close 帧回一个 close 帧后断开，
// 否则 undici 的 WebSocket 会一直挂着 socket，进程退不掉。
function readFrames(socket, onText) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        socket.write(encodeFrame(0x8, Buffer.alloc(0)));
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0x1) onText(frame.payload.toString("utf8"));
    }
  });
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload, consumed: offset + length };
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}
