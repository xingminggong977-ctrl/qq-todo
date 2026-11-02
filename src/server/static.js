import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// PWA 的 sw.js 一旦被缓存就永远换不掉，必须 no-store。
const NO_STORE = new Set(['sw.js']);

async function fileStat(p) {
  try {
    const st = await stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function fallbackPage() {
  return Buffer.from(
    '<!doctype html><meta charset="utf-8"><title>前端尚未就绪</title>'
      + '<body style="background:#0b0b0f;color:#e8e8f0;font:16px/1.7 system-ui;padding:40px">'
      + '<h1>public/ 还没有前端文件</h1>'
      + '<p>API 已在运行：<a style="color:#7c5cff" href="/api/health">/api/health</a></p></body>',
    'utf8',
  );
}

export function createStaticHandler({ dir }) {
  const root = path.resolve(dir);

  return async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      rel = pathname;
    }
    const safeRel = path.posix.normalize(rel).replace(/^\/+/, '');

    let target = path.resolve(root, safeRel);
    // path.resolve 已吃掉了 ..，这里守住上界，避免越出 public/。
    if (target !== root && !target.startsWith(root + path.sep)) {
      return sendNotFound(res);
    }

    let st = await fileStat(target);
    if (!st) {
      const asIndex = await fileStat(path.join(target, 'index.html'));
      if (asIndex) {
        target = path.join(target, 'index.html');
        st = asIndex;
      }
    }
    if (!st) {
      // 没有扩展名才回落 index.html；带扩展名说明是真资源，缺了就该 404。
      const looksLikeAsset = safeRel !== '' && path.extname(safeRel) !== '';
      if (looksLikeAsset) return sendNotFound(res);
      target = path.join(root, 'index.html');
      st = await fileStat(target);
    }
    if (!st) {
      const body = fallbackPage();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const name = path.basename(target);
    const cache = NO_STORE.has(name)
      ? 'no-store, must-revalidate'
      : ext === '.html'
        ? 'no-cache'
        : 'public, max-age=300';
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
      'Last-Modified': st.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}

function sendNotFound(res) {
  const body = Buffer.from('404 页面不存在', 'utf8');
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
