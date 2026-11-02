// 只缓存静态外壳；/api/ 一律走网络，避免把接口数据写进缓存。
// 策略：外壳「缓存优先 + 后台更新」——隧道偶发抖动时点开图标也能瞬间出界面；
//      页面导航「网络优先但只等 3 秒」，超时立刻用缓存，不让白屏转圈。
const CACHE = 'qqtd-shell-v7';
const SHELL = [
  './', './index.html', './app.js', './styles.css', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-180.png',
];
const NAV_TIMEOUT = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        // 单个文件缺失不应阻断安装
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function refresh(key, res) {
  const cache = await caches.open(CACHE);
  if (res && res.ok && res.type === 'basic') await cache.put(key, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isShell = SHELL.some((p) => new URL(p, self.location.href).pathname === url.pathname);
  const cacheKey = new Request(url.origin + url.pathname);

  // 1) 外壳文件：缓存优先，后台顺手更新，保证「点开就有」
  if (isShell) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(cacheKey) || await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then((res) => refresh(cacheKey, res)).catch(() => null);
      if (hit) {
        event.waitUntil(network);
        return hit;
      }
      const res = await network;
      if (res) return res;
      return new Response('离线中，且本地没有这一页的缓存', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })());
    return;
  }

  // 2) 页面导航：最多等 3 秒网络，超时或失败就用缓存，不让人干等
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const t = timeout(NAV_TIMEOUT);
      try {
        const res = await fetch(req, { signal: t.signal });
        t.done();
        await refresh(cacheKey, res);
        return res;
      } catch (err) {
        t.done();
        const hit = await cache.match('./index.html', { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  // 3) 其他同源 GET：网络优先，失败回落缓存
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      return await fetch(req);
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

// ---------- 到期提醒（Web Push） ----------
// 后端推过来的可能是 JSON，也可能是一条纯文本；两种都要能出通知，最后的兜底是不让人看见空通知。
const PUSH_FALLBACK = { title: '待办提醒', body: '你有一条待办要到期了', url: '/', tag: 'qqtd-remind' };

function readPushPayload(event) {
  const data = event.data;
  if (!data) return PUSH_FALLBACK;
  try {
    const json = data.json();
    if (json && typeof json === 'object') {
      const url = json.url || (json.data && json.data.url) || PUSH_FALLBACK.url;
      return {
        title: String(json.title || PUSH_FALLBACK.title),
        body: String(json.body || json.text || PUSH_FALLBACK.body),
        url: String(url),
        tag: String(json.tag || PUSH_FALLBACK.tag),
      };
    }
  } catch (err) {
    // 不是 JSON，往下按纯文本读
  }
  try {
    const text = data.text();
    if (text) return { ...PUSH_FALLBACK, body: String(text) };
  } catch (err) {
    // 连文本都读不出来，用默认文案
  }
  return PUSH_FALLBACK;
}

self.addEventListener('push', (event) => {
  const payload = readPushPayload(event);
  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: payload.tag,
        data: { url: payload.url },
      });
    } catch (err) {
      // 通知被系统拦下时不要让 SW 报错
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of wins) {
      try {
        await win.focus();
        if (typeof win.navigate === 'function') await win.navigate(target);
        return;
      } catch (err) {
        // 这个窗口已经不在了，试下一个
      }
    }
    await self.clients.openWindow(target);
  })());
});
