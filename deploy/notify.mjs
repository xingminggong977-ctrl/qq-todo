/**
 * 把待办摘要通过 NapCat 私聊推给 owner。
 * 用途：手机上不用打开网页也能看到今天的待办。
 *
 * 发送链路导出成 sendPrivateText，deploy/weekly-digest.mjs 直接复用，别再写第二份。
 */
import { pathToFileURL } from 'node:url';

// 服务器上 7788 是 HTTPS 口（TLS），明文 HTTP 走 PORT（线上是 7789）。
const APP = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || 7788}`;
const APP_TOKEN = process.env.AUTH_TOKEN || '';

const DRY = /^(1|on|true)$/i.test(String(process.env.DRY_RUN || '').trim());

// 只读 API 小工具：remind.mjs 与 weekly-digest.mjs 共用，Connection: close 免得 keep-alive 拖住进程
export async function api(path) {
  // Connection: close —— 脚本发完就退出，别让 undici 的 keep-alive 连接把进程留在事件循环里
  const res = await fetch(`${APP}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(APP_TOKEN)}`, {
    headers: { Connection: 'close' },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function dayLabel(days) {
  if (typeof days !== 'number') return '';
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return '今天到期';
  if (days === 1) return '明天到期';
  return `${days} 天后到期`;
}

// 服务端 /api/todos 已返回 daysLeft，这里只在老接口/字段缺失时兜底算一次
export function daysUntil(deadline) {
  if (!deadline) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const a = Date.parse(`${today}T00:00:00+08:00`);
  const b = Date.parse(`${deadline}T00:00:00+08:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function leftOf(todo) {
  return typeof todo.daysLeft === 'number' ? todo.daysLeft : daysUntil(todo.deadline);
}

export function buildDigest(stats, todos) {
  const pending = (todos.items || []).filter((t) => t.status === 'pending');
  const due = pending
    .map((t) => ({ ...t, daysLeft: leftOf(t) }))
    .filter((t) => typeof t.daysLeft === 'number')
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const soon = due.slice(0, 6);
  const noDeadline = pending.filter((t) => leftOf(t) === null).length;

  const lines = [];
  const c = stats.counts || {};
  lines.push(`待办台 · ${new Date().toLocaleDateString('zh-CN')}`);
  lines.push(`现在有 ${c.pending ?? pending.length} 件要处理，最近的是：`);
  lines.push('');
  soon.forEach((t, i) => {
    const tag = dayLabel(t.daysLeft);
    lines.push(`${i + 1}. ${t.title}`);
    lines.push(`   ${tag}${t.deadline ? ` · ${t.deadline}` : ''}${t.source?.groupName ? ` · ${t.source.groupName}` : ''}`);
  });
  if (soon.length === 0) lines.push('（没有带截止日期的待办）');
  if (noDeadline > 0) lines.push('', `另有 ${noDeadline} 件没写截止日期，网页上能看到全部。`);
  const pnl = stats.funnel;
  if (pnl) lines.push('', `累计从 ${pnl.messagesProcessed} 条消息里留下 ${pnl.todosKept} 件。`);
  return lines.join('\n');
}

// 服务器上有 ws 包；本地只有 Node 24 的全局 WebSocket（undici 扩展支持 headers）。
// 两条路发的是同一个 send_private_msg 动作，优先用 ws 保持线上行为不变。
async function openSocket(url, headers) {
  try {
    const mod = await import('ws');
    const WS = mod.WebSocket || mod.default?.WebSocket || mod.default || mod;
    return new WS(url, { headers, handshakeTimeout: 8000 });
  } catch {
    return new WebSocket(url, { headers });
  }
}

// ws 用 .on(event)，浏览器/undici 的 WebSocket 只有 addEventListener，这里抹平差异
function listen(socket, event, handler) {
  if (typeof socket.on === 'function') {
    socket.on(event, handler);
    return;
  }
  socket.addEventListener(event, (ev) => {
    if (event === 'message') handler(ev?.data ?? ev);
    else if (event === 'error') handler(ev?.error ?? new Error('WS ERROR'));
    else handler(ev);
  });
}

export async function sendPrivateText(text, { timeoutMs = 20000, echo = 'notify' } = {}) {
  const WS_URL = process.env.NAPCAT_WS_URL || 'ws://127.0.0.1:3001';
  const TO_QQ = String(process.env.OWNER_QQ || '').trim();
  const WS_TOKEN = process.env.NAPCAT_ACCESS_TOKEN || '';
  if (!TO_QQ) throw new Error('OWNER_QQ 缺失');

  const socket = await openSocket(WS_URL, { Authorization: `Bearer ${WS_TOKEN}` });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* 已经断了就不用管 */ }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('TIMEOUT')), timeoutMs);

    listen(socket, 'open', () => {
      socket.send(JSON.stringify({
        action: 'send_private_msg',
        params: { user_id: Number(TO_QQ), message: [{ type: 'text', data: { text } }] },
        echo,
      }));
    });
    listen(socket, 'message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.echo !== echo) return;
      finish(null, {
        ok: msg.status === 'ok' || msg.retcode === 0,
        status: msg.status,
        retcode: msg.retcode,
        detail: JSON.stringify(msg.data || {}).slice(0, 120),
      });
    });
    listen(socket, 'error', (err) => finish(new Error(`WS ERROR ${err?.message || ''}`.trim())));
    listen(socket, 'close', () => finish(new Error('WS CLOSED')));
  });
}

async function main() {
  if (!APP_TOKEN) throw new Error('AUTH_TOKEN 缺失');
  if (!String(process.env.OWNER_QQ || '').trim()) throw new Error('OWNER_QQ 缺失');

  const stats = await api('/api/stats');
  const todos = await api('/api/todos?status=all&limit=200');
  const text = buildDigest(stats, todos);

  if (DRY) {
    console.log(text);
    return 0;
  }

  const result = await sendPrivateText(text);
  console.log(`sent -> ${process.env.OWNER_QQ}: ${result.status} ${result.detail}`);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 不硬退：Windows 上 process.exit 会踩 libuv 的 UV_HANDLE_CLOSING 断言。
  // api() 带 Connection: close，发送链路也会关掉 socket，事件循环自然空掉。
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
