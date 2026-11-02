import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, resolveDataDir } from '../config.js';
import { buildContext, startLive } from './deps.js';
import { startPoller } from '../live/poller.js';
import { createApp } from './app.js';
import { printBanner } from './banner.js';
import { createPush } from './push.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

// 手机浏览器会把空闲连接留 60s 以上再复用，撞上默认 5s 的 keepAliveTimeout 就成了「有时点不开、刷一下又好了」。
// requestTimeout=0 是给长轮询留的：服务端不能因为一个请求等久了就自己掐线。
const KEEP_ALIVE_MS = 65000;
const HEADERS_TIMEOUT_MS = 66000;

function tuneKeepAlive(server) {
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = 0;
  return server;
}

// Host 头来自客户端，只接受「域名/IP + 可选端口」，其余一律当没给，免得拼出 https://evil 这种跳转
// 证书里写了哪些域名（SAN），用于按 SNI 选证书
function certHosts(pem) {
  try {
    const x = new crypto.X509Certificate(pem);
    const san = String(x.subjectAltName || '');
    const hosts = san
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('DNS:'))
      .map((s) => s.slice(4).toLowerCase());
    if (hosts.length) return hosts;
    const cn = /CN=([^,\n]+)/.exec(String(x.subject || ''));
    return cn ? [cn[1].trim().toLowerCase()] : [];
  } catch {
    return [];
  }
}

// 支持 *.example.com 这种通配
function matchHost(pattern, name) {
  if (!pattern || !name) return false;
  if (pattern === name) return true;
  if (pattern.startsWith('*.')) {
    const rest = pattern.slice(2);
    return name.endsWith(`.${rest}`) && name.indexOf(`.${rest}`) === name.length - rest.length - 1;
  }
  return false;
}

function sanitizeHost(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const host = value.replace(/:\d+$/, '');
  if (/^[A-Za-z0-9.-]+$/.test(host)) return host;
  if (/^\[[0-9A-Fa-f:.]+\]$/.test(host)) return host;
  return '';
}

// PUBLIC_URL 是给人看的（可能带协议、路径、端口），这里只取 host 部分
function httpsHostFrom(publicUrl) {
  const value = String(publicUrl || '').trim();
  if (!value) return '';
  try {
    return sanitizeHost(new URL(value).host);
  } catch {
    return sanitizeHost(value.replace(/^https?:\/\//i, '').split('/')[0]);
  }
}

// 端上自报「我是从桌面图标打开的还是浏览器打开的」，用来远程确认安装是否生效。
const PRESENCE_MAX = 2048;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handlePresence(req, res, dataDir) {
  try {
    const raw = await readBody(req, PRESENCE_MAX);
    const info = raw ? JSON.parse(raw) : {};
    const line = JSON.stringify({
      at: new Date().toISOString(),
      display: String(info.display || '').slice(0, 24),
      standalone: info.standalone === true,
      w: Number(info.w) || 0,
      h: Number(info.h) || 0,
      cookie: Boolean(req.headers.cookie),
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
    });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.appendFile(path.join(dataDir, 'presence.log'), `${line}\n`);
    console.log('[presence]', line);
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
  } catch {
    res.writeHead(400, { 'cache-control': 'no-store' });
    res.end('bad presence');
  }
}

function isOn(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'on' || text === 'true' || text === '1';
}

// 决策日志是事后审计：写失败只告警，绝不能让这一轮抽取失败或回滚。
async function persistDecisions(store, result) {
  const decisions = result?.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) return;
  try {
    const pending = decisions.filter((d) => d && d.messageId && d.todoId == null);
    if (pending.length) {
      // pipeline 不一定知道 todoId（新建的 todo 要进 store 后才有 id），按 messageId 反查补上
      const { items } = (await store.listTodos({ limit: 5000 })) ?? {};
      const byMessage = new Map();
      for (const todo of items ?? []) {
        if (todo?.messageId && todo?.id) byMessage.set(todo.messageId, todo.id);
      }
      for (const entry of pending) {
        if (byMessage.has(entry.messageId)) entry.todoId = byMessage.get(entry.messageId);
      }
    }
    await store.recordDecisions(decisions);
  } catch (err) {
    console.warn('[decisions] 决策日志写入失败（不影响抽取结果）', err?.message ?? err);
  }
}

// 新待办即时提醒：抽取出新待办后立刻拉起一次 deploy/notify-new.mjs（带 QQ 推送）。
// 拆成子进程是因为它要用 CLI 的参数解析与状态文件；失败只告警，绝不能影响抽取结果。
// 注意路径：脚本的 import 是相对 deploy/ 写的（../src/store.js、./notify.mjs），不能平铺到根目录。
function notifyNewTodos(rootDir, env, createdCount) {
  if (!(Number(createdCount) > 0)) return;
  if (String(env.NOTIFY_NEW_ON_EXTRACT ?? "on").toLowerCase() === "off") return;
  try {
    const child = spawn(process.execPath, [path.join(rootDir, "deploy", "notify-new.mjs")], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch (err) {
    console.warn("[notify-new] 拉起失败（不影响抽取）", err?.message ?? err);
  }
}

async function main() {
  const env = loadEnv(process.cwd());
  // PORT=0 是「让内核挑一个空闲端口」，自测靠它避免和本机已起的实例抢端口；所以不能用 || 兜底
  const port = Number.isFinite(Number(env.PORT)) ? Number(env.PORT) : 7788;
  const host = env.HOST || '0.0.0.0';

  const { store, deps } = await buildContext(env);

  // 所有抽取（页面按钮、定时轮询）都走 deps.extract.run，包一层就能统一落决策日志
  const runExtractOnce = deps.extract.run;
  deps.extract.run = async (options) => {
    const result = await runExtractOnce(options);
    await persistDecisions(store, result);
    notifyNewTodos(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), env, result?.todosCreated);
    return result;
  };

  // 推送是可选能力：没配 VAPID 也建出来，enabled=false 时所有发送静默跳过。
  // 建失败只影响推送，不能让整站起不来。
  try {
    const push = createPush({ env, store, log: console });
    deps.push = () => push;
  } catch (err) {
    console.error('[push] 初始化失败，推送已关闭', err?.message ?? err);
    deps.push = () => null;
  }

  // 订阅器是可选的：连不上只影响 /api/live，不能拖垮整个服务。
  if (isOn(env.LIVE_ENABLED)) {
    try {
      const live = startLive({
        env,
        onMessage: (message) => {
          store.addMessages([message]).catch((err) => console.error('[live] 消息入库失败', err));
        },
      });
      deps.setLive(live);
      live.ready?.catch?.((err) => console.error('[live] 首次连接失败（会自动重连）', err));
    } catch (err) {
      console.error('[live] 订阅器启动失败，服务继续运行', err);
    }
  }

  const dataDir = resolveDataDir(env);

  // 定时回补历史：不依赖用户手动转发，也不依赖推送是否可靠。
  // 与订阅器彼此独立：任一条挂了不影响另一条，两个开关各自生效。
  // LIVE_POLL_EXTRACT=on 时，有新消息就顺手跑一次判定，用户不必再去点「开始判断」。
  const extractAfterPoll = isOn(env.LIVE_POLL_EXTRACT);
  let extractBusy = false;
  let poller = null;
  if (isOn(env.LIVE_POLL_ENABLED)) {
    try {
      poller = startPoller({
        env,
        store,
        log: (...args) => console.log(...args),
        afterEach: async (summary, { signal } = {}) => {
          if (!extractAfterPoll) return;
          // processed 里含每群页首那条已知游标消息，插入数才是「有没有新东西」；
          // errors 不是门槛：某群拉挂了不代表其它群没新消息。
          if (!(summary?.inserted > 0)) return;
          if (extractBusy) {
            console.log('[poll] 上一次自动提取还在跑，本轮跳过（积压会在下一轮补齐）');
            return;
          }
          extractBusy = true;
          const startedAt = Date.now();
          try {
            const result = await deps.extract.run({ env, store, signal });
            console.log(
              `[poll] 自动提取完成：处理 ${result?.processed ?? 0} 条、新增待办 ${result?.todosCreated ?? 0}、` +
                `丢弃 ${result?.droppedCount ?? 0}、耗时 ${Date.now() - startedAt}ms`,
            );
          } finally {
            extractBusy = false;
          }
        },
      });
      poller.ready?.catch?.((err) => console.error('[poll] 首轮失败（会按退避重试）', err));
    } catch (err) {
      poller = null;
      console.error('[poll] 定时拉取启动失败，服务继续运行', err);
    }
  }
  const app = createApp({ env, store, deps, publicDir: PUBLIC_DIR });
  const handler = (req, res) => {
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/presence') {
      void handlePresence(req, res, dataDir);
      return;
    }
    app(req, res);
  };

  // 演示库首建要跑一次 stub 抽取（1~2s）。等监听与横幅都落地后再预热，
  // 免得第一个访客把这段时间算到自己头上；失败了首访还会重试，不影响服务。
  if (app.demo) {
    setTimeout(() => {
      app.demo.ensure().catch((err) => console.warn('[demo] 预热失败（首访会重试）', err?.message ?? err));
    }, 1500).unref?.();
  }

  // 有证书就在 HTTPS_PORT 上再开一个 TLS 监听（对外），原 PORT 退到本机供内部脚本用。
  // 证书还没签下来时只跑 HTTP，别让服务起不来。
  const tlsCert = String(env.TLS_CERT || '').trim();
  const tlsKey = String(env.TLS_KEY || '').trim();
  const httpsPort = Number(env.HTTPS_PORT) || 0;
  let secureServer = null;
  if (tlsCert && tlsKey && httpsPort > 0) {
    let candidate = null;
    try {
      const [cert, key] = await Promise.all([fs.readFile(tlsCert), fs.readFile(tlsKey)]);
      // 备用域名（如 sslip.io 的 IP 域名）：同一台机器上按 SNI 选证书，
      // 因为主域名的证书覆盖不到它，而主域名在某些线路上拿不到标准端口。
      const altCertPath = String(env.TLS_ALT_CERT || '').trim();
      const altKeyPath = String(env.TLS_ALT_KEY || '').trim();
      let sniCallback = null;
      if (altCertPath && altKeyPath) {
        try {
          const [altCert, altKey] = await Promise.all([fs.readFile(altCertPath), fs.readFile(altKeyPath)]);
          // 按证书自己涵盖的域名选，不按 PUBLIC_URL 选：换个对外地址不该把 TLS 弄坏
          const altHosts = certHosts(altCert);
          const mainHosts = certHosts(cert);
          const altCtx = tls.createSecureContext({ cert: altCert, key: altKey });
          const mainCtx = tls.createSecureContext({ cert, key });
          sniCallback = (servername, cb) => {
            const name = String(servername || '').toLowerCase();
            if (altHosts.some((h) => matchHost(h, name)) && !mainHosts.some((h) => matchHost(h, name))) {
              cb(null, altCtx);
              return;
            }
            cb(null, mainCtx);
          };
        } catch (err) {
          console.error('[server] 备用证书未加载，全部用主证书：', err.message);
        }
      }
      candidate = https.createServer({ cert, key, ...(sniCallback ? { SNICallback: sniCallback } : {}) }, handler);
      candidate.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        else socket.destroy();
      });
      tuneKeepAlive(candidate);
      await new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(httpsPort, '0.0.0.0', () => {
          candidate.off('error', reject);
          resolve();
        });
      });
      secureServer = candidate;
      console.log(`[server] HTTPS 已启用：0.0.0.0:${httpsPort}`);
    } catch (err) {
      // 443 被占用、证书路径写错都不该把整个服务拖死：关掉半开的 server，继续跑其它端口
      try {
        candidate?.close();
      } catch {
        /* 已经关掉就算了 */
      }
      secureServer = null;
      console.error('[server] HTTPS 未启用（证书读不到或端口占用）：', err.message);
    }
  }

  // 老书签、二维码里残留的 http:// 链接都靠这层一键升级到 https，否则用户会看到「连不上」
  let redirectServer = null;
  const acmeRoot = env.ACME_WEBROOT || '';
  // acme.sh 的 http-01 校验会打 80 端口的 /.well-known/acme-challenge/<token>，
  // 这条请求不能跟着 301 去 https（换证时证书可能正好不在）。
  async function serveAcmeChallenge(req, res) {
    if (!acmeRoot) return false;
    const prefix = '/.well-known/acme-challenge/';
    const url = req.url || '';
    if (!url.startsWith(prefix)) return false;
    const raw = url.slice(prefix.length).split('?')[0];
    let name = '';
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = '';
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === '.' || name === '..') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad token\n');
      return true;
    }
    try {
      const body = await fs.readFile(path.join(acmeRoot, '.well-known', 'acme-challenge', name));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
    }
    return true;
  }
  const fallbackHost = httpsHostFrom(env.PUBLIC_URL);
  const redirectPort = Number(env.REDIRECT_PORT) || 0;
  if (redirectPort > 0) {
    let candidate = null;
    try {
      candidate = http.createServer(async (req, res) => {
        if (await serveAcmeChallenge(req, res)) return;
        const host = sanitizeHost(req.headers.host) || fallbackHost;
        if (!host) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('缺少 Host 头，且 PUBLIC_URL 未配置，无法跳转\n');
          return;
        }
        const suffix = req.url && req.url.startsWith('/') ? req.url : `/${req.url ?? ''}`;
        res.writeHead(301, { location: `https://${host}${suffix}`, 'cache-control': 'no-store' });
        res.end();
      });
      candidate.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        else socket.destroy();
      });
      tuneKeepAlive(candidate);
      await new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(redirectPort, '0.0.0.0', () => {
          candidate.off('error', reject);
          resolve();
        });
      });
      redirectServer = candidate;
      console.log(`[server] 80 跳转已启用：0.0.0.0:${redirectPort} → https（回落 host：${fallbackHost || '无，看 Host 头'}）`);
    } catch (err) {
      try {
        candidate?.close();
      } catch {
        /* 同上 */
      }
      redirectServer = null;
      console.error('[server] 80 跳转未启用（端口占用或无权限）：', err.message);
    }
  }

  const server = http.createServer(handler);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });
  tuneKeepAlive(server);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  await printBanner({ env, port: actualPort });
  console.log(
    `[server] keep-alive：keepAliveTimeout=${KEEP_ALIVE_MS}ms、headersTimeout=${HEADERS_TIMEOUT_MS}ms、requestTimeout=0（长轮询不设上限）`,
  );

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在收尾…`);
    const hardStop = setTimeout(() => process.exit(1), 5000);
    hardStop.unref();
    try {
      deps.live()?.stop?.();
      poller?.stop?.();
      poller?.closeClient?.();
      for (const s of [server, secureServer, redirectServer]) {
        s?.closeIdleConnections?.();
      }
      const closer = new Promise((resolve) => server.close(resolve));
      setTimeout(() => server.closeAllConnections?.(), 300).unref();
      await closer;
      for (const s of [secureServer, redirectServer]) {
        if (s) await new Promise((resolve) => s.close(resolve));
      }
      await store.flush?.();
    } catch (err) {
      console.error('[server] 退出时出错', err);
    }
    clearTimeout(hardStop);
    console.log('已退出');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return { server, secureServer, redirectServer, store, env };
}

// 导出启动 Promise：自测（fixtures/selftests/server-ports.mjs）要直接读真实 server 的
// keepAliveTimeout / headersTimeout，这些属性只在监听器对象上，走 HTTP 只能间接推断。
export const booted = main().catch((err) => {
  console.error('[server] 启动失败：', err);
  process.exit(1);
});

