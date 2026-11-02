/**
 * 到期提醒：把「已逾期 / 今天到期 / 明天到期」的待办通过 NapCat 私聊推给 owner。
 *
 * 为什么另开一条 QQ 通道：服务器上 curl https://fcm.googleapis.com/... 是 000（14s 超时），
 * 国产安卓上 Web Push 基本收不到，QQ 私聊是唯一稳定的路。
 *
 * 只读：只调 /api/todos，不改任何数据；DRY_RUN=1 只打印不发送。
 */
import { pathToFileURL } from 'node:url';
import { api, daysUntil, sendPrivateText } from './notify.mjs';

const DRY = /^(1|on|true)$/i.test(String(process.env.DRY_RUN || '').trim());
const MAX_PER_BUCKET = 5;

const BUCKETS = [
  { key: 'overdue', label: '已逾期' },
  { key: 'today', label: '今天到期' },
  { key: 'tomorrow', label: '明天到期' },
];

function dueOf(todo) {
  return typeof todo.daysLeft === 'number' ? todo.daysLeft : daysUntil(todo.deadline);
}

/** 三档分组；没有需要提醒的返回 null。 */
export function groupDue(todos) {
  const buckets = { overdue: [], today: [], tomorrow: [] };
  for (const todo of todos.items || []) {
    if (todo.status !== 'pending') continue;
    const days = dueOf(todo);
    if (typeof days !== 'number') continue;
    if (days < 0) buckets.overdue.push({ todo, days });
    else if (days === 0) buckets.today.push({ todo, days });
    else if (days === 1) buckets.tomorrow.push({ todo, days });
  }
  return buckets;
}

export function buildReminder(todos, nowMs = Date.now()) {
  const buckets = groupDue(todos);
  const counts = {
    overdue: buckets.overdue.length,
    today: buckets.today.length,
    tomorrow: buckets.tomorrow.length,
  };
  if (counts.overdue + counts.today + counts.tomorrow === 0) return null;

  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(nowMs));

  const lines = [`待办提醒 · ${date}`, `逾期 ${counts.overdue} · 今天 ${counts.today} · 明天 ${counts.tomorrow}`];
  for (const { key, label } of BUCKETS) {
    const items = buckets[key];
    if (items.length === 0) continue;
    lines.push('', `【${label} ${items.length} 件】`);
    items.slice(0, MAX_PER_BUCKET).forEach(({ todo, days }, i) => {
      const when = days < 0 ? `已逾期 ${-days} 天` : days === 0 ? '今天' : '明天';
      const where = todo.source?.groupName ? ` · ${todo.source.groupName}` : '';
      lines.push(`${i + 1}. ${todo.title} · ${when}${where}`);
    });
    if (items.length > MAX_PER_BUCKET) lines.push(`… 另有 ${items.length - MAX_PER_BUCKET} 件同类，网页上看全部`);
  }
  return lines.join('\n');
}

async function main() {
  const todos = await api('/api/todos?status=pending&limit=200');
  const text = buildReminder(todos);
  if (!text) {
    console.log('nothing-due');
    return 0;
  }
  if (DRY) {
    console.log(text);
    return 0;
  }
  const result = await sendPrivateText(text, { echo: 'remind' });
  console.log(`sent -> ${process.env.OWNER_QQ}: ${result.status} ${result.detail}`);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 不硬退：Windows 上 process.exit 紧跟 fetch 会踩 libuv 的 UV_HANDLE_CLOSING 断言。
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
