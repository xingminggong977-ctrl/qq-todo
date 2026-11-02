import { Buffer } from 'node:buffer';
import { createApi } from './api.js';
import { createDemo } from './demo.js';
import { HttpError, parseCookies, sendError } from './http.js';
import { createStaticHandler } from './static.js';

const COOKIE_MAX_AGE = 31536000; // 365 天：装到桌面的 PWA 不能动不动要求重新带口令

// 浏览器在解析 HTML 时就会去抓 manifest 与图标，这一次请求可能早于 Set-Cookie 落地；
// 若也要过闸，首次扫码安装会拿到 401 并被浏览器记住为「manifest 不可用」。
// 这些只是安装元数据，不含任何用户数据，放行不影响 AUTH_TOKEN 保护的 /api/* 与页面本体。
const PUBLIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/sw.js',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-180.png',
]);

function authorized(req, url, token) {
  const queryToken = url.searchParams.get('t');
  if (queryToken !== null && queryToken === token) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies.qqtd === token;
}

// 未授权时：API 保持 JSON；浏览器直接打开页面则给一个能输令牌的落地页，
// 免得用户看到一屏 JSON 以为坏了（2026-11-01 用户实拍反馈）。
const UNAUTHORIZED_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>QQ 待办台 · 需要访问口令</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 80% at 50% 0%,#241a3d 0%,#0d0b12 60%);color:#e8e6f0;
    font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:24px}
  .card{width:100%;max-width:420px;background:#16131d;border:1px solid #2a2438;border-radius:18px;padding:26px 22px}
  h1{margin:0 0 6px;font-size:19px;letter-spacing:.02em}
  p{margin:0 0 18px;color:#9d98ad;font-size:13.5px}
  input{width:100%;padding:13px 14px;border-radius:12px;border:1px solid #322b44;background:#0f0d15;
    color:#e8e6f0;font-size:15px;outline:none}
  input:focus{border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.18)}
  button{margin-top:12px;width:100%;padding:13px;border:0;border-radius:12px;cursor:pointer;
    background:linear-gradient(180deg,#8b6cff,#6d4bf0);color:#fff;font-size:15px;font-weight:600}
  button:active{transform:translateY(1px)}
  .hint{margin-top:16px;font-size:12.5px;color:#6f6a80}
  code{background:#221d2e;padding:1px 5px;border-radius:5px;color:#b9b2cc}
</style></head>
<body><div class="card">
  <h1>需要访问口令</h1>
  <p>这个页面不对外开放。粘贴口令后，浏览器会记住 365 天，之后直接输域名即可。</p>
  <form id="f">
    <input id="t" name="t" placeholder="粘贴访问口令（形如一串 32 位十六进制）"
           autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
    <button type="submit">进入待办台</button>
  </form>
  <div class="hint">口令在当初那条带 <code>?t=</code> 的链接里。找不到就问我要一个。</div>
</div>
<script>
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('t').value.trim();
    if (!v) return;
    location.href = '/?t=' + encodeURIComponent(v);
  });
</script>
</body></html>`;

function wantsHtml(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html');
}

function handleError(res, err) {
  if (err instanceof HttpError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  console.error('[server] 未处理异常', err);
  sendError(res, 500, 'internal_error', err?.message ? String(err.message) : '服务器内部错误');
}

export function createApp({ env, store, deps, publicDir, demo: injectedDemo }) {
  const api = createApi({ env, store, deps });
  const serveStatic = createStaticHandler({ dir: publicDir });
  const token = String(env.AUTH_TOKEN ?? '').trim();
  const demoEnabled = String(env.DEMO_ENABLED ?? process.env.DEMO_ENABLED ?? 'on').toLowerCase() !== 'off';
  // 演示必须能匿名打开，所以它排在 AUTH_TOKEN 闸门之前；能读到的只有 <DATA_DIR>/demo 这个独立库。
  const demo = demoEnabled ? (injectedDemo ?? createDemo({ env, log: console })) : null;

  const handler = async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/demo' || url.pathname.startsWith('/demo/')) {
        // 关掉时不回 401/403：那不是「没权限」，是「没这东西」，别暴露它的存在。
        if (!demo) {
          sendError(res, 404, 'not_found', '页面不存在');
          return;
        }
        await demo.handle({ req, res, url });
        return;
      }

      // SPEC §4：AUTH_TOKEN 非空时 /api/* 与页面本体都要过闸；安装元数据除外（见 PUBLIC_PATHS）。
      if (token && !PUBLIC_PATHS.has(url.pathname)) {
        if (!authorized(req, url, token)) {
          const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
          if (!isApi && wantsHtml(req)) {
            res.writeHead(401, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Length': Buffer.byteLength(UNAUTHORIZED_PAGE),
              'Cache-Control': 'no-store',
            });
            res.end(UNAUTHORIZED_PAGE);
            return;
          }
          sendError(res, 401, 'unauthorized', '需要访问令牌，请用带 ?t= 的链接打开');
          return;
        }
        res.setHeader(
          'Set-Cookie',
          `qqtd=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`,
        );
      }

      const { pathname } = url;
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await api({ req, res, url });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '静态资源只支持 GET / HEAD');
        return;
      }
      await serveStatic(req, res, pathname);
    } catch (err) {
      handleError(res, err);
    }
  };

  handler.demo = demo; // index.js 拿它做启动预热
  return handler;
}
