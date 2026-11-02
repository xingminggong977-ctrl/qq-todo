// 端口与 keep-alive 自测：直接把真实服务起在本进程里，读的是监听器对象本身。
// 走 HTTP 只能间接推断 keepAliveTimeout，而它正是「手机偶尔点不开」的元凶，必须直接断言。
// 跑法：node fixtures/selftests/server-ports.mjs
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const PASS = [];
const FAIL = [];

function check(no, title, ok, expected, actual) {
  if (ok) {
    PASS.push(no);
    console.log(`PASS ${no} ${title}`);
    console.log(`        期望 ${expected} · 实际 ${actual}`);
  } else {
    FAIL.push(no);
    console.log(`FAIL ${no} ${title}`);
    console.log(`  期望：${expected}`);
    console.log(`  实际：${actual}`);
  }
}

// 先占一个高位端口再放掉：让 REDIRECT_PORT 是「真实的随机端口」，不是写死的
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// 只发请求、不改 Host，才能测「Host 缺失」和「Host 带端口」这两种情况
function rawGet(port, reqPath, { host, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'GET',
        setHost,
        ...(host !== undefined ? { headers: { host } } : {}),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-todo-ports-'));
const redirectPort = await freePort();

process.env.DATA_DIR = dataDir;
process.env.PORT = '0';
process.env.HTTPS_PORT = '0';
process.env.REDIRECT_PORT = String(redirectPort);
process.env.AUTH_TOKEN = '';
process.env.LIVE_ENABLED = 'off';
process.env.LIVE_POLL_ENABLED = 'off';
process.env.LLM_PROVIDER = 'stub';
process.env.PUBLIC_URL = 'https://todo.example.com';
process.env.TLS_CERT = '';
process.env.TLS_KEY = '';

const { booted } = await import('../../src/server/index.js');
const { server, redirectServer } = await booted;
const mainPort = server.address().port;

console.log(`临时实例：DATA_DIR=${dataDir}`);
console.log(`主端口 ${mainPort}（PORT=0）、跳转端口 ${redirectPort}（REDIRECT_PORT）、HTTPS_PORT=0 故不开 TLS`);

// ① 80 侧任意 GET → 301，Location 是 https，且 path+query 原样保留
const r1 = await rawGet(redirectPort, '/todos?status=done&x=1', { host: 'todo.example.com' });
check(
  '1',
  '80 侧 GET 跳 https 且保留 path+query',
  r1.status === 301 && r1.headers.location === 'https://todo.example.com/todos?status=done&x=1',
  '301 + https://todo.example.com/todos?status=done&x=1',
  `${r1.status} + ${r1.headers.location ?? '无 location'}`,
);

// ② Host 带端口时要剥掉，否则会跳成 https://host:7788（443 端口对不上）
const r2 = await rawGet(redirectPort, '/api/health', { host: 'todo.example.com:7788' });
check(
  '2',
  'Host 带端口时去除端口',
  r2.status === 301 && r2.headers.location === 'https://todo.example.com/api/health',
  '301 + https://todo.example.com/api/health',
  `${r2.status} + ${r2.headers.location ?? '无 location'}`,
);

// 裸 socket 发一个「完全不带 Host」的请求：HTTP/1.0 才允许这么干，
// HTTP/1.1 缺 Host 会被 Node 的解析器在进 handler 之前直接 400，测不到回落逻辑。
function rawSocket(port, requestText) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(requestText));
    socket.setTimeout(3000);
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const status = Number(buf.slice(0, 12).split(' ')[1]);
      const location = /\r\nlocation:\s*([^\r\n]+)/i.exec(buf)?.[1];
      resolve({ status, location });
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('裸 socket 超时'));
    });
    socket.on('error', reject);
  });
}

// ③ Host 缺失 / 非法 → 回落 PUBLIC_URL 的 host
const r3a = await rawSocket(redirectPort, 'GET /a?b=1 HTTP/1.0\r\n\r\n');
const r3b = await rawGet(redirectPort, '/a?b=1', { host: 'evil.com/../x' });
check(
  '3',
  'Host 缺失或非法时回落 PUBLIC_URL',
  r3a.status === 301 && r3a.location === 'https://todo.example.com/a?b=1' &&
    r3b.headers.location === 'https://todo.example.com/a?b=1',
  '两次都跳 https://todo.example.com/a?b=1',
  `无 Host(HTTP/1.0)→${r3a.location ?? `无（${r3a.status}）`}；非法 Host→${r3b.headers.location ?? '无'}`,
);

// ④ 没分配的端口不该有人监听（避免「以为关掉了其实还开着一个」）
const stranger = await canConnect(4601);
check('4', '未分配的 4601 不监听', stranger === false, '连接被拒绝', stranger ? '居然连上了' : 'ECONNREFUSED');

// ⑤ keep-alive 三件套：直接读监听器属性，三台都要设上
const tuned = [server, redirectServer].filter(Boolean);
const bad = tuned.filter(
  (s) => s.keepAliveTimeout !== 65000 || s.headersTimeout !== 66000 || s.requestTimeout !== 0,
);
check(
  '5',
  'keepAliveTimeout / headersTimeout / requestTimeout',
  bad.length === 0 && tuned.length >= 2,
  '两台监听器都是 65000 / 66000 / 0',
  tuned.map((s) => `${s.keepAliveTimeout}/${s.headersTimeout}/${s.requestTimeout}`).join('，') +
    `（${tuned.length} 台）`,
);

// ⑥ 主端口仍在正常服务，跳转层没有抢掉业务
const health = await rawGet(mainPort, '/api/health');
check('6', '主端口业务正常', health.status === 200, '200', String(health.status));

await new Promise((resolve) => server.close(resolve));
if (redirectServer) await new Promise((resolve) => redirectServer.close(resolve));
rmSync(dataDir, { recursive: true, force: true });

console.log('');
if (FAIL.length) {
  console.log(`server-ports 失败：${FAIL.length} 项未通过（${FAIL.join(', ')}）`);
  process.exitCode = 1;
} else {
  console.log(`server-ports 通过：${PASS.length} 项断言全部 OK`);
}
