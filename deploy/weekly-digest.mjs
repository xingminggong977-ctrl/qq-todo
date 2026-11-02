#!/usr/bin/env node
/**
 * 每周复盘推送：读 /api/todos 与 /api/stats，按「本周一 00:00 → 下周一 00:00（Asia/Shanghai）」算窗口，
 * 拼一条文本交给 notify.mjs 的私聊链路发出去。只读接口，不写库。
 *
 * 用法：node deploy/weekly-digest.mjs [--dry-run]
 */
import { pathToFileURL } from 'node:url';
import { sendPrivateText } from './notify.mjs';

const TZ = 'Asia/Shanghai';
// 内部脚本走本机明文监听（.env 里的 PORT）；线上 7788 是 TLS 端口，用 http 打会握手失败
const APP = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || 7788}`;
const APP_TOKEN = process.env.AUTH_TOKEN || '';
const MAX_ITEMS = 5;
const MESSAGE_PAGE = 1000;

const DRY = process.argv.includes('--dry-run')
  || /^(1|on|true)$/i.test(String(process.env.DRY_RUN || '').trim());

async function api(path) {
  // Connection: close —— 脚本发完就退出，别让 undici 的 keep-alive 连接把进程留在事件循环里
  const res = await fetch(`${APP}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(APP_TOKEN)}`, {
    headers: { Connection: 'close' },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function dayStart(isoDate) {
  return Date.parse(`${isoDate}T00:00:00+08:00`);
}

function todayInShanghai(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(nowMs));
}

// 本周一 00:00 起算；下周窗口单独返回，方便「下周要到期」在任何一天跑都算得对
export function weekWindow(nowMs) {
  const today = todayInShanghai(nowMs);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=周日
  const sinceMonday = (dow + 6) % 7;
  const start = dayStart(today) - sinceMonday * 86400000;
  const nextStart = start + 7 * 86400000;
  return { start, end: nextStart, nextStart, nextEnd: nextStart + 7 * 86400000 };
}

function msOf(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

function deadlineMs(todo) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(todo.deadline || '')) ? dayStart(todo.deadline) : null;
}

function deadlineLabel(todo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todo.deadline || ''))) return '';
  const [, m, d] = todo.deadline.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function itemLine(index, todo) {
  const parts = [String(todo.title || '').trim() || '(无标题)'];
  const when = deadlineLabel(todo);
  if (when) parts.push(when);
  const group = String(todo.source?.groupName || '').trim();
  if (group) parts.push(group);
  return `${index}. ${parts.join(' · ')}`;
}

function section(title, todos) {
  const lines = ['', title];
  todos.slice(0, MAX_ITEMS).forEach((todo, i) => lines.push(itemLine(i + 1, todo)));
  if (todos.length > MAX_ITEMS) lines.push(`…还有 ${todos.length - MAX_ITEMS} 件，网页上看全部。`);
  return lines;
}

export function buildWeeklyDigest({ stats = {}, todos = {}, messages = null, nowMs = Date.now() } = {}) {
  const counts = stats.counts || {};
  const items = Array.isArray(todos.items) ? todos.items : [];
  const week = weekWindow(nowMs);

  const inThisWeek = (ms) => ms !== null && ms >= week.start && ms < week.end;
  const created = items.filter((t) => inThisWeek(msOf(t.createdAt)));
  const createdDone = created.filter((t) => t.status === 'done');

  const pending = items.filter((t) => t.status === 'pending');
  const overdue = pending
    .map((t) => ({ todo: t, at: deadlineMs(t) }))
    .filter((x) => x.at !== null && x.at < dayStart(todayInShanghai(nowMs)))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.todo);
  const nextWeek = pending
    .map((t) => ({ todo: t, at: deadlineMs(t) }))
    .filter((x) => x.at !== null && x.at >= week.nextStart && x.at < week.nextEnd)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.todo);

  // 「本周新收」只能按消息时间戳数；/api/messages 一次最多 1000 条，翻满且全在本周就标个 +
  const list = Array.isArray(messages?.items) ? messages.items : [];
  const weekMessages = list.filter((m) => inThisWeek(msOf(m.ts)));
  const truncated = list.length >= MESSAGE_PAGE && weekMessages.length === list.length;
  const received = messages === null ? '若干' : `${weekMessages.length}${truncated ? '+' : ''}`;

  const lines = [
    '【本周复盘】',
    `本周新收 ${received} 条，判定 ${created.length} 条待办（其中 ${createdDone.length} 条已做）`,
    `已完成 ${Number(counts.done) || 0} · 逾期 ${overdue.length} · 下周到期 ${nextWeek.length}`,
  ];

  if (overdue.length === 0 && nextWeek.length === 0) {
    lines.push('', '这周没有拖尾巴的，放心。');
    return lines.join('\n');
  }
  if (overdue.length > 0) lines.push(...section('逾期未处理：', overdue));
  if (nextWeek.length > 0) lines.push(...section('下周要到期：', nextWeek));
  return lines.join('\n');
}

async function main() {
  if (!APP_TOKEN) throw new Error('AUTH_TOKEN 缺失');

  const stats = await api('/api/stats');
  const todos = await api('/api/todos?status=all&limit=500');
  // 消息接口只用来数「本周新收」；数不到也不该让整条复盘发不出去
  let messages = null;
  try {
    messages = await api(`/api/messages?limit=${MESSAGE_PAGE}`);
  } catch (err) {
    console.error(`[weekly] 消息接口不可用，本周新收按「若干」写：${err.message}`);
  }

  const text = buildWeeklyDigest({ stats, todos, messages });

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
  // api() 已经带 Connection: close，发送链路也会关掉 socket，事件循环自然空掉。
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
