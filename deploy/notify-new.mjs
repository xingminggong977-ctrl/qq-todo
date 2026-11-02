/**
 * 新待办即时提醒：抽取出新待办之后，立刻通过 QQ 私聊推一条。
 *
 * 为什么要独立进程：poller 抽完新待办只落库，用户要等 08:05 / 20:00 的定时器才知道。
 * 这里由 systemd timer 每 10 分钟扫一次 store（只读盘，不依赖服务在线），
 * 有新 id 就推；重复的不推、一小时最多 3 次、被限流的累积到下一次。
 *
 * 状态文件：<DATA_DIR>/notify-new-state.json（可用 NOTIFY_NEW_STATE_FILE 覆盖，测试写 /tmp）
 *   { version, lastNotifiedAt, sentIds[], pendingIds[], pushes[] }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/store.js';
import { sendPrivateText } from './notify.mjs';

export const STATE_VERSION = 1;
export const MAX_SENT_IDS = 500;
export const MAX_DISPLAY = 5;
export const MAX_PENDING_IDS = 200;
export const RATE_LIMIT_PUSHES = 3;
export const RATE_WINDOW_MS = 3600 * 1000;



function emptyState() {
  return { version: STATE_VERSION, lastNotifiedAt: null, sentIds: [], pendingIds: [], pushes: [] };
}

function trimList(list, max) {
  return list.slice(Math.max(0, list.length - max));
}

function uniq(list) {
  return [...new Set(list.filter((id) => typeof id === 'string' && id))];
}

export function readState(file) {
  if (!existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      version: STATE_VERSION,
      lastNotifiedAt: typeof raw.lastNotifiedAt === 'string' ? raw.lastNotifiedAt : null,
      sentIds: Array.isArray(raw.sentIds) ? trimList(raw.sentIds.filter((x) => typeof x === 'string'), MAX_SENT_IDS) : [],
      pendingIds: Array.isArray(raw.pendingIds) ? trimList(raw.pendingIds.filter((x) => typeof x === 'string'), MAX_PENDING_IDS) : [],
      pushes: Array.isArray(raw.pushes) ? raw.pushes.filter((x) => Number.isFinite(x)) : [],
    };
  } catch {
    // 状态文件坏了就当没有：宁可多推一次，也不要整个提醒卡死
    return emptyState();
  }
}

/** tmp + rename：断电也不会留下半个 JSON。 */
export function writeState(file, state) {
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/** --ids a,b / --since 2026-11-02T10:00:00+08:00 / --dry-run */
export function parseArgs(argv = []) {
  const out = { ids: null, since: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--ids') {
      const value = String(argv[i + 1] ?? '');
      i += 1;
      out.ids = uniq(value.split(',').map((x) => x.trim()));
    } else if (arg.startsWith('--ids=')) out.ids = uniq(arg.slice(6).split(',').map((x) => x.trim()));
    else if (arg === '--since') {
      const value = String(argv[i + 1] ?? '').trim();
      i += 1;
      out.since = Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    } else if (arg.startsWith('--since=')) {
      const value = arg.slice(8).trim();
      out.since = Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    }
  }
  return out;
}

function deadlineLabel(todo) {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(todo.deadline ?? ''));
  if (hit) return `${Number(hit[2])}月${Number(hit[3])}日截止`;
  const text = String(todo.deadlineText ?? '').trim();
  return text ? `${text}截止` : '未标注截止';
}

function beijingStamp(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${Number(pick('month'))}月${Number(pick('day'))}日 ${pick('hour')}:${pick('minute')}`;
}

/** 文案：首行带北京时间，最多列 5 条，超出写「…还有 N 件」。 */
export function buildText(todos, nowMs = Date.now()) {
  const shown = todos.slice(0, MAX_DISPLAY);
  const lines = [`新待办 · ${beijingStamp(nowMs)}`];
  shown.forEach((todo, i) => {
    const group = String(todo.source?.groupName ?? '').trim();
    lines.push(`${i + 1}. ${todo.title} ｜ ${deadlineLabel(todo)}${group ? ` · ${group}` : ''}`);
  });
  if (todos.length > shown.length) lines.push(`…还有 ${todos.length - shown.length} 件`);
  lines.push(`共 ${todos.length} 件，打开待办台查看`);
  return lines.join('\n');
}

function createdAtMs(todo) {
  const ms = Date.parse(String(todo?.createdAt ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 挑出这次要推的待办：显式 --ids 优先，否则按 createdAt > 游标。
 * 已被推过的 id（sentIds）一律剔除。
 */
export function selectNewTodos({ todos, ids = null, cutoffMs = null, sentIds = [] }) {
  const sent = new Set(sentIds);
  if (Array.isArray(ids)) {
    const byId = new Map(todos.map((t) => [t.id, t]));
    return ids.filter((id) => byId.has(id) && !sent.has(id)).map((id) => byId.get(id));
  }
  if (cutoffMs === null) return [];
  return todos.filter((t) => {
    if (sent.has(t.id)) return false;
    const created = createdAtMs(t);
    return created !== null && created > cutoffMs;
  });
}

/**
 * 主流程（可注入 store / send / now，便于自测）。
 * 返回 { code, action, ids, text, reason }，action ∈ send | nothing-new | baseline | rate-limited | send-failed | dry-run
 */
export async function runNotifyNew({
  store,
  send,
  dataDir = process.env.DATA_DIR || './data',
  stateFile = process.env.NOTIFY_NEW_STATE_FILE || '',
  argv = process.argv.slice(2),
  env = process.env,
  now = () => Date.now(),
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  const dryRun = args.dryRun || /^(1|on|true)$/i.test(String(env.DRY_RUN || '').trim());
  const statePath = stateFile || path.join(dataDir, 'notify-new-state.json');
  const nowMs = now();

  const state = readState(statePath);
  const cutoffMs = args.since ?? (state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : null);
  // 第一次跑且没给 --since：只记基线，不把历史待办一次性全推一遍
  if (!Array.isArray(args.ids) && cutoffMs === null) {
    state.lastNotifiedAt = new Date(nowMs).toISOString();
    if (!dryRun) writeState(statePath, state);
    log('baseline：首次运行，只记录游标，不推送历史待办');
    return { code: 0, action: 'baseline', ids: [], text: '' };
  }

  const todos = store.listTodos({ status: 'pending', limit: 1000 }).items;
  const fresh = selectNewTodos({ todos, ids: args.ids, cutoffMs, sentIds: state.sentIds });

  // 上一轮被限流压住的，和这一轮新的一起推
  const queued = state.pendingIds.filter((id) => !state.sentIds.includes(id));
  const merged = uniq([...queued, ...fresh.map((t) => t.id)]);
  const byId = new Map([...todos, ...fresh].map((t) => [t.id, t]));
  const items = merged.map((id) => byId.get(id)).filter(Boolean);

  if (items.length === 0) {
    state.lastNotifiedAt = new Date(nowMs).toISOString();
    if (!dryRun) writeState(statePath, state);
    log('nothing-new');
    return { code: 0, action: 'nothing-new', ids: [], text: '' };
  }

  const text = buildText(items, nowMs);

  // 限流：滚动的 1 小时窗口内最多 3 次；被压住的 id 累积到下一轮
  const pushes = state.pushes.filter((ms) => nowMs - ms < RATE_WINDOW_MS);
  if (pushes.length >= RATE_LIMIT_PUSHES) {
    state.pushes = pushes;
    state.pendingIds = trimList(merged, MAX_PENDING_IDS);
    state.lastNotifiedAt = new Date(nowMs).toISOString();
    if (!dryRun) writeState(statePath, state);
    log(`rate-limited：本小时已推 ${pushes.length} 次，${merged.length} 件攒到下一轮`);
    return { code: 0, action: 'rate-limited', ids: merged, text };
  }

  if (dryRun) {
    log(text);
    return { code: 0, action: 'dry-run', ids: merged, text };
  }

  let result;
  try {
    result = await send(text, { echo: 'notify-new' });
  } catch (err) {
    result = { ok: false, detail: err?.message || String(err) };
  }
  if (!result?.ok) {
    // 发失败不动 sentIds，也不推进 pendingIds——下一轮重试同一批
    state.pushes = pushes;
    state.pendingIds = trimList(merged, MAX_PENDING_IDS);
    writeState(statePath, state);
    log(`发送失败：${result?.detail || 'unknown'}`);
    return { code: 1, action: 'send-failed', ids: merged, text, reason: result?.detail || 'unknown' };
  }

  state.sentIds = trimList(uniq([...state.sentIds, ...merged]), MAX_SENT_IDS);
  state.pendingIds = [];
  state.pushes = [...pushes, nowMs];
  state.lastNotifiedAt = new Date(nowMs).toISOString();
  writeState(statePath, state);
  log(`sent -> ${env.OWNER_QQ || '?'}: ${result.status ?? 'ok'} ${result.detail ?? ''}`.trim());
  return { code: 0, action: 'send', ids: merged, text, reason: null };
}

async function main() {
  const dataDir = process.env.DATA_DIR || './data';
  const store = createStore({ dataDir });
  const result = await runNotifyNew({
    store,
    dataDir,
    send: (text, opts) => sendPrivateText(text, opts),
  });
  return result.code;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 不硬退：Windows 上 process.exit 紧跟 fetch 会踩 libuv 断言
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err?.message || String(err));
    process.exitCode = 1;
  });
}
