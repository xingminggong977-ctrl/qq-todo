import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createReadStream, statSync, statfsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { toBeijingISO } from '../shared/message.js';
import { daysLeft, todayISO } from '../shared/time.js';
import { HttpError, readJsonBody, sendJson } from './http.js';

const VERSION = '1.0.0';
const TODO_STATUSES = new Set(['pending', 'done', 'dismissed']);
const DECISION_VERDICTS = new Set(['todo', 'dropped', 'noise', 'implicit', 'error']);
const GROUP_MODES = new Set(['normal', 'quiet', 'blocked']);
const MAX_DECISIONS = 500;

// 只服务 live 落盘的这几种图；其它扩展名一律 application/octet-stream，别猜成 HTML 让浏览器渲染
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function readInt(raw, fallback, min, max, name = 'limit') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, 'bad_request', `${name} 必须是数字`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeRunId() {
  return `r_${randomBytes(4).toString('hex')}`;
}

function nowISO() {
  return toBeijingISO(Math.floor(Date.now() / 1000));
}

// 运维视野：线上没人盯着，health 要能自证「有多少数据、盘还剩多少、抽过没有」。
// 观测失败一律退化成安全默认值——健康检查自己绝不允许因为探针抛错变成非 200。
function safeFileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function safeDiskFree(dir) {
  try {
    const st = statfsSync(dir);
    return num(st.bavail) * num(st.bsize);
  } catch {
    return 0;
  }
}

// Run 里没有 durationMs 字段，用起止时间算，算不出来就给 0。
function briefExtract(run) {
  if (!run || typeof run !== 'object') return null;
  const started = Date.parse(run.startedAt ?? '');
  const finished = Date.parse(run.finishedAt ?? '');
  const durationMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
  return {
    durationMs,
    costUsd: num(run.costUsd),
    provider: typeof run.provider === 'string' ? run.provider : null,
  };
}

// 「明天」「今天 22:00」这类说法只有相对用户所在时区才有意义；服务器可能跑在 UTC 上，
// 所以一律按 Asia/Shanghai 换算，不碰进程的 TZ。
const APP_TIME_ZONE = 'Asia/Shanghai';

function beijingDay(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + offsetDays));
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// 推后到「哪一天」用 00:00:00 表示（从那天起重新出现），今晚则落到 22:00。
function snoozeUntil(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'tomorrow') return `${beijingDay(1)}T00:00:00+08:00`;
  if (value === 'tonight') return `${beijingDay(0)}T22:00:00+08:00`;
  if (value === '3d') return `${beijingDay(3)}T00:00:00+08:00`;
  if (value === '1w') return `${beijingDay(7)}T00:00:00+08:00`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00+08:00`))) {
    return `${value}T00:00:00+08:00`;
  }
  throw new HttpError(400, 'bad_request', 'snooze 只能是 tomorrow / tonight / 3d / 1w / YYYY-MM-DD，或 null 取消推后');
}

// iCalendar 规定这几个字符必须转义，反斜杠必须最先换，否则会把后面补的转义再转义一遍。
function icsEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// RFC 5545 要求折行不超过 75 字节（不是字符），续行以单个空格开头。
function icsFold(line) {
  const chunks = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > 75) {
      chunks.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

function icsUtcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// 只导出「pending 且有 deadline」的待办：全天事件没有日期就没法落进日历。
function buildCalendar(todos) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//qq-todo//calendar 1.0//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const todo of todos) {
    const day = String(todo.deadline ?? '').slice(0, 10).replace(/-/g, '');
    const constraints = Array.isArray(todo.constraints) ? todo.constraints.join('/') : '';
    const groupName = todo.source?.groupName ?? '';
    lines.push(
      'BEGIN:VEVENT',
      `UID:${todo.id}@qq-todo`,
      `DTSTAMP:${icsUtcStamp()}`,
      `DTSTART;VALUE=DATE:${day}`,
      `SUMMARY:${icsEscape(todo.title)}`,
      `DESCRIPTION:${icsEscape(`来源 ${groupName} · 约束 ${constraints}`)}`,
      'CATEGORIES:待办',
      'BEGIN:VALARM',
      'TRIGGER:-P1D',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape(todo.title)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

// Windows Excel 打开 UTF-8 CSV 必须看到 BOM，否则中文全是乱码——导出功能的关键验收点。
const CSV_BOM = '\uFEFF';
const CSV_COLUMNS = ['标题', '截止日期', '剩余天数', '状态', '来源群', '判定依据', '创建时间', '原文摘要'];
// 批量改状态的单次上限：再多就不该走一次请求，得让调用方分页，否则一个 body 就能把内存占满
const BULK_MAX_IDS = 200;

// RFC 4180：含逗号 / 双引号 / 换行的字段整格加引号，内部引号翻倍。
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells) {
  return cells.map(csvCell).join(',');
}

// 整张表要绝对单行：换行会把一行记录拆散，Excel 里就变成错行的脏数据，grep 也数不准
function csvFlat(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function csvSummary(text, max = 80) {
  const flat = csvFlat(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// 导出顺序照「先看快到期、同一天看最新」：有截止日的在前，同日按创建时间倒序
function byDeadlineThenCreated(a, b) {
  const da = String(a.deadline ?? '');
  const db = String(b.deadline ?? '');
  if (da !== db) {
    if (!da) return 1;
    if (!db) return -1;
    return da < db ? -1 : 1;
  }
  const ca = String(a.createdAt ?? '');
  const cb = String(b.createdAt ?? '');
  if (ca === cb) return 0;
  return ca < cb ? 1 : -1;
}

function buildCsv(todos, textById) {
  const rows = [csvLine(CSV_COLUMNS)];
  for (const todo of todos.slice().sort(byDeadlineThenCreated)) {
    const deadline = String(todo.deadline ?? '').slice(0, 10);
    const left = deadline ? daysLeft(deadline) : null;
    rows.push(
      csvLine([
        todo.title,
        deadline,
        left === null ? '' : String(left),
        todo.status,
        todo.source?.groupName ?? '',
        csvFlat(todo.reason ?? ''),
        todo.createdAt ?? '',
        csvSummary(textById.get(todo.messageId) ?? ''),
      ]),
    );
  }
  return `${CSV_BOM}${rows.join('\r\n')}\r\n`;
}

// SPEC §4 的 10 个端点。数据访问一律走 store，不碰 store.json。

export function createApi({ env, store, deps }) {
  const providerName = () => env.LLM_PROVIDER || 'stub';
  const str = (value) => (typeof value === 'string' ? value.trim() : '');

  async function health({ res }) {
    const counts = (await store.counts()) ?? {};
    let lastExtract = null;
    try {
      const runs = (await store.listRuns(50)) ?? [];
      lastExtract = briefExtract(runs.find((run) => run && run.kind === 'extract'));
    } catch {
      lastExtract = null;
    }
    let liveConnected = false;
    try {
      liveConnected = !!deps.live?.()?.status?.().connected;
    } catch {
      liveConnected = false; // 订阅器自己坏了也不该让体检面板挂掉
    }
    // 推送是否武装、有多少台设备订阅着：手机收不到提醒时，第一个要看的就是这两个数
    let pushSubscriptions = 0;
    try {
      pushSubscriptions = num((await store.listPushSubscriptions?.())?.items?.length);
    } catch {
      pushSubscriptions = 0;
    }
    const visionEnabled = ['on', 'true', '1'].includes(
      (str(env.VISION_ENABLED) || str(process.env.VISION_ENABLED) || 'on').toLowerCase(),
    );
    const visionModel = str(env.VISION_MODEL) || str(process.env.VISION_MODEL) || 'qwen3-vl-plus';
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      provider: providerName(),
      counts: {
        messages: num(counts.messages),
        todos: num(counts.todos),
        pending: num(counts.pending),
        done: num(counts.done),
      },
      storeBytes: safeFileSize(store.file),
      messages: num(counts.messages),
      todos: num(counts.todos),
      lastExtract,
      liveConnected,
      push: { enabled: !!deps.push?.()?.enabled, subscriptions: pushSubscriptions },
      // 视觉识别关掉时，消息里就不会有图片描述；面板要能看出是「关着」还是「坏了」
      vision: { enabled: visionEnabled, model: visionModel },
      diskFreeBytes: safeDiskFree(store.dataDir),
      uptimeSec: Math.round(process.uptime()),
    });
  }

  async function listMessages({ res, url }) {
    const limit = readInt(url.searchParams.get('limit'), 100, 1, 1000);
    const group = str(url.searchParams.get('group'));
    const noise = str(url.searchParams.get('noise'));
    const result = (await store.listMessages({
      limit,
      group: group || undefined,
      noise: noise || undefined,
    })) ?? {};
    const items = Array.isArray(result.items) ? result.items : [];
    sendJson(res, 200, {
      // imageFile 在 store 里是服务器绝对路径，前端只要文件名；绝对路径绝不出网
      items: items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const file = str(item.imageFile);
        return { ...item, imageFile: file ? path.basename(file) : null };
      }),
      total: num(result.total, items.length),
      groups: Array.isArray(result.groups) ? result.groups : [],
    });
  }

  async function ingest({ req, res }) {
    const body = await readJsonBody(req);
    const content = body.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new HttpError(400, 'bad_request', 'content 不能为空');
    }
    const filename = str(body.filename) || 'upload.txt';
    const format = str(body.format);
    const startedAt = nowISO();

    const parsed = (await deps.ingest.parse(filename, content, format ? { format } : undefined)) ?? {};
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [];
    const saved = (await store.addMessages(messages)) ?? {};
    const imported = num(saved.imported);
    const skipped = num(saved.skipped);

    const run = (await store.addRun({
      id: makeRunId(),
      kind: 'ingest',
      startedAt,
      finishedAt: nowISO(),
      imported,
      skipped,
      processed: 0,
      todos: 0,
      errors: 0,
      provider: providerName(),
      costUsd: 0,
    })) ?? {};
    const groups = [...new Set(messages.map((m) => m?.groupName).filter(Boolean))];

    sendJson(res, 200, { runId: run.id ?? makeRunId(), imported, skipped, groups, warnings });
  }

  async function extract({ req, res }) {
    const body = await readJsonBody(req);
    const limit = readInt(body.limit, 0, 0, 200000, 'limit');
    const force = body.force === true;
    const group = str(body.group) || null;
    const startedAt = Date.now();

    const result = (await deps.extract.run({ env, store, limit, force, group })) ?? {};
    sendJson(res, 200, {
      runId: result.runId ?? makeRunId(),
      processed: num(result.processed),
      todosCreated: num(result.todosCreated),
      provider: result.provider ?? providerName(),
      durationMs: num(result.durationMs, Date.now() - startedAt),
      costUsd: num(result.costUsd),
      // 丢了几条、调了几次模型是「这一轮可不可信」的关键信号，前端与 CLI 都要看到；量在前、错在后
      droppedCount: num(result.droppedCount),
      droppedMessageIds: Array.isArray(result.droppedMessageIds) ? result.droppedMessageIds.map(String) : [],
      // 模型自己判成「不是待办」的条数：和 droppedCount 是两件事，别混着看
      implicitNegatives: num(result.implicitNegatives),
      coveredCount: num(result.coveredCount),
      modelCalls: num(result.modelCalls),
      maxCalls: num(result.maxCalls),
      // 视觉识图的用量：失败不影响判定，但「这一轮读了几张图」要能看到，否则查不出漏判
      visionUsed: num(result.visionUsed),
      visionSkipped: num(result.visionSkipped),
      visionFailed: num(result.visionFailed),
      errors: Array.isArray(result.errors) ? result.errors.map(String) : [],
    });
  }

  async function listTodos({ res, url }) {
    const rawStatus = str(url.searchParams.get('status')).toLowerCase() || 'pending';
    if (rawStatus !== 'all' && !TODO_STATUSES.has(rawStatus)) {
      throw new HttpError(400, 'bad_request', 'status 只能是 pending / done / dismissed / all');
    }
    const limit = readInt(url.searchParams.get('limit'), 200, 1, 2000);
    const result = (await store.listTodos({ status: rawStatus, limit })) ?? {};
    const stats = result.stats ?? {};
    const items = Array.isArray(result.items) ? result.items : [];
    sendJson(res, 200, {
      // daysLeft 由服务端算好：前端与推送脚本都不该各自再猜一次时区
      items: items.map((t) => ({ ...t, daysLeft: daysLeft(t.deadline) })),
      stats: {
        pending: num(stats.pending),
        done: num(stats.done),
        dismissed: num(stats.dismissed),
      },
    });
  }

  async function getTodo({ res, params }) {
    const todo = await store.getTodo(params[0]);
    if (!todo) throw new HttpError(404, 'not_found', '待办不存在');
    const message = todo.messageId ? await store.getMessage(todo.messageId) : null;
    sendJson(res, 200, { todo, message: message ?? null });
  }

  async function patchTodo({ req, res, params }) {
    const body = await readJsonBody(req);
    const status = str(body.status);
    // 三态：没给 snooze = 别动；给 null 或空串 = 显式取消推后；其余 = 设置推后时间
    const hasSnooze = body.snooze !== undefined;
    const snoozeRaw = hasSnooze ? String(body.snooze ?? '').trim() : '';
    const clearSnooze = hasSnooze && snoozeRaw === '';
    // deadline 同样三态：没给 = 别动；null 或空串 = 清掉截止日；YYYY-MM-DD = 手填
    const hasDeadline = body.deadline !== undefined;
    const deadlineRaw = hasDeadline ? String(body.deadline ?? '').trim() : '';
    // status / snooze / deadline 至少给一个
    if (!status && !hasSnooze && !hasDeadline) {
      throw new HttpError(400, 'bad_request', 'status、snooze、deadline 至少要给一个');
    }
    if (status && !TODO_STATUSES.has(status)) {
      throw new HttpError(400, 'bad_request', 'status 只能是 pending / done / dismissed');
    }

    let todo = await store.getTodo(params[0]);
    if (!todo) throw new HttpError(404, 'not_found', '待办不存在');

    if (status) {
      todo = (await store.setTodoStatus(params[0], status)) ?? todo;
    }
    if (hasSnooze) {
      const until = clearSnooze ? null : snoozeUntil(snoozeRaw);
      try {
        todo = (await store.snoozeTodo(params[0], until)) ?? todo;
      } catch (err) {
        // 日期在 store 侧被判定无效（含已过去的推后时间）时，是调用方的锅，不要变成 500
        const code = String(err?.code ?? err?.message ?? '');
        if (code.includes('invalid_snooze')) {
          throw new HttpError(400, 'bad_request', 'snooze 时间无效');
        }
        throw err;
      }
    }
    if (hasDeadline) {
      try {
        todo = (await store.setTodoDeadline(params[0], deadlineRaw || null)) ?? todo;
      } catch (err) {
        const code = String(err?.code ?? err?.message ?? '');
        if (code.includes('invalid_deadline')) {
          throw new HttpError(400, 'bad_request', 'deadline 只接受 YYYY-MM-DD，或用 null 清空');
        }
        throw err;
      }
    }
    if (!todo) throw new HttpError(404, 'not_found', '待办不存在');

    const counts = (await store.counts()) ?? {};
    sendJson(res, 200, {
      todo: { ...todo, daysLeft: daysLeft(todo.deadline) },
      stats: { pending: num(counts.pending), done: num(counts.done), dismissed: num(counts.dismissed) },
    });
  }

  // 批量改状态：一次点「全部标为已读」不该发 N 个 PATCH，也不该让前端自己算每次都数的增量
  async function bulkTodos({ req, res }) {
    const body = await readJsonBody(req);
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HttpError(400, 'bad_request', 'ids 必须是非空数组');
    }
    if (ids.length > BULK_MAX_IDS) {
      throw new HttpError(400, 'too_many', `一次最多改 ${BULK_MAX_IDS} 条，收到 ${ids.length} 条`);
    }
    const status = str(body.status);
    if (!TODO_STATUSES.has(status)) {
      throw new HttpError(400, 'bad_request', 'status 只能是 pending / done / dismissed');
    }
    const result = (await store.setTodoStatusMany(ids.map(String), status)) ?? {};
    // stats 一起回去：前端改完立刻要重画计数，让它再拉一次 /api/stats 是白白多一个来回
    const stats = (await store.getStats()) ?? {};
    sendJson(res, 200, { updated: num(result.updated), skipped: num(result.skipped), stats });
  }

  async function calendar({ res }) {
    const result = (await store.listTodos({ status: 'pending', limit: 2000 })) ?? {};
    const items = (Array.isArray(result.items) ? result.items : []).filter(
      (todo) =>
        todo &&
        typeof todo.deadline === 'string' &&
        /^\d{4}-\d{2}-\d{2}/.test(todo.deadline) &&
        // 推后到未来 = 「这段时间别提醒我」，日历里再挂 VALARM 等于把推后当没发生
        (!todo.snoozedUntil || Date.parse(todo.snoozedUntil) <= Date.now()),
    );
    const body = buildCalendar(items);
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async function exportCsv({ res, url }) {
    const rawStatus = str(url.searchParams.get('status')).toLowerCase() || 'all';
    if (rawStatus !== 'all' && !TODO_STATUSES.has(rawStatus)) {
      throw new HttpError(400, 'bad_request', 'status 只能是 pending / done / dismissed / all');
    }
    const group = str(url.searchParams.get('group') ?? '');
    const result = (await store.listTodos({ status: rawStatus, limit: 0, group })) ?? {};
    const items = Array.isArray(result.items) ? result.items : [];
    // 摘要要回原文：一次取全量建索引，不要每条 getMessage 一次
    const messageResult = (await store.listMessages({ limit: 0 })) ?? {};
    const textById = new Map((Array.isArray(messageResult.items) ? messageResult.items : []).map((m) => [m.id, m.text]));
    const body = buildCsv(items, textById);
    const stamp = todayISO().replace(/-/g, '');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="qq-todo-${stamp}.csv"`,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async function decisions({ res, url }) {
    const query = url.searchParams;
    const verdict = str(query.get('verdict') ?? '');
    if (verdict && !DECISION_VERDICTS.has(verdict)) {
      throw new HttpError(400, 'bad_request', 'verdict 只能是 todo / dropped / noise / implicit / error');
    }
    const result =
      (await store.listDecisions({
        limit: readInt(query.get('limit'), 50, 1, MAX_DECISIONS, 'limit'),
        verdict: verdict || undefined,
        groupName: str(query.get('group') ?? '') || undefined,
        messageId: str(query.get('msg') ?? '') || undefined,
      })) ?? {};
    sendJson(res, 200, {
      items: Array.isArray(result.items) ? result.items : [],
      total: num(result.total),
    });
  }

  // store 还没定死 getGroupSettings 的返回形状（map / 数组都可能），这里统一收成 Map
  function groupSettingsMap(raw) {
    const out = new Map();
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
    if (rows) {
      for (const row of rows) {
        if (!row?.groupName) continue;
        out.set(row.groupName, { mode: row.mode ?? 'normal', note: row.note ?? '' });
      }
      return out;
    }
    if (raw && typeof raw === 'object') {
      for (const [name, value] of Object.entries(raw)) {
        if (!name) continue;
        if (typeof value === 'string') out.set(name, { mode: value, note: '' });
        else if (value && typeof value === 'object') out.set(name, { mode: value.mode ?? 'normal', note: value.note ?? '' });
      }
    }
    return out;
  }

  async function groups({ res }) {
    const settings = groupSettingsMap(await store.getGroupSettings?.());
    const snapshot = (await store.getStats()) ?? {};
    const byGroup = Array.isArray(snapshot.byGroup) ? snapshot.byGroup : [];
    const items = [];
    const seen = new Set();
    for (const row of byGroup) {
      if (!row?.groupName) continue;
      seen.add(row.groupName);
      const setting = settings.get(row.groupName) ?? { mode: 'normal', note: '' };
      items.push({
        groupName: row.groupName,
        mode: setting.mode,
        note: setting.note,
        messages: num(row.messages),
        todos: num(row.todos),
      });
    }
    // 只在设置里出现、还没有消息的群也要能配，否则先拉黑再进群的顺序走不通
    for (const [groupName, setting] of settings) {
      if (seen.has(groupName)) continue;
      items.push({ groupName, mode: setting.mode, note: setting.note, messages: 0, todos: 0 });
    }
    sendJson(res, 200, { items });
  }

  async function patchGroup({ req, res, params }) {
    const body = await readJsonBody(req);
    const mode = str(body.mode);
    if (!GROUP_MODES.has(mode)) {
      throw new HttpError(400, 'bad_request', 'mode 只能是 normal / quiet / blocked');
    }
    const name = params[0];
    await store.setGroupMode(name, mode);
    const setting = groupSettingsMap(await store.getGroupSettings?.()).get(name) ?? { mode, note: '' };
    const snapshot = (await store.getStats()) ?? {};
    const row = (Array.isArray(snapshot.byGroup) ? snapshot.byGroup : []).find((g) => g?.groupName === name);
    sendJson(res, 200, {
      ok: true,
      group: {
        groupName: name,
        mode: setting.mode,
        note: setting.note,
        messages: num(row?.messages),
        todos: num(row?.todos),
      },
    });
  }

  async function stats({ res }) {
    const result = (await store.getStats()) ?? {};
    if (!result.provider) result.provider = providerName();
    sendJson(res, 200, result);
  }

  async function live({ res }) {
    const instance = deps.live?.() ?? null;
    if (!instance) {
      sendJson(res, 200, {
        enabled: false,
        connected: false,
        privateEnabled: false,
        groups: [],
        lastEventAt: null,
      });
      return;
    }
    let status = {};
    try {
      status = instance.status() ?? {};
    } catch {
      status = {}; // 订阅器自身异常不该让整页接口挂掉
    }
    sendJson(res, 200, {
      enabled: !!status.enabled,
      connected: !!status.connected,
      // 私聊转发通道是否武装：.env 里有 OWNER_QQ 才开
      privateEnabled: !!status.privateEnabled,
      groups: Array.isArray(status.groups) ? status.groups : [],
      lastEventAt: status.lastEventAt ?? null,
      // 心跳指标：只给一个 connected 布尔的话，半开连接也会报「正常」
      lastHeartbeatAt: status.lastHeartbeatAt ?? null,
      reconnects: Number.isFinite(status.reconnects) ? status.reconnects : 0,
      lastReconnectAt: status.lastReconnectAt ?? null,
      heartbeatOk: status.heartbeatOk === true ? true : status.heartbeatOk === false ? false : null,
    });
  }

  // 推送是可选能力：没配 VAPID 时所有端点照常 200，只是 enabled=false、发送静默跳过。
  const push = () => deps.push?.() ?? null;

  // store 只回 {items}，订阅总数这里自己数；数不出来就给 0，别让写成功的请求因为统计失败变成 500
  async function pushSubscriptionTotal(target) {
    try {
      return num((await target.listPushSubscriptions?.())?.items?.length);
    } catch {
      return 0;
    }
  }

  async function pushKey({ res }) {
    const instance = push();
    sendJson(res, 200, { enabled: !!instance?.enabled, publicKey: instance?.publicKey?.() ?? '' });
  }

  async function pushSubscribe({ req, res }) {
    const body = await readJsonBody(req);
    const endpoint = str(body.endpoint);
    const keys = body.keys ?? {};
    const p256dh = str(keys.p256dh);
    const auth = str(keys.auth);
    if (!endpoint || !p256dh || !auth) {
      throw new HttpError(400, 'invalid_subscription', 'endpoint 与 keys.p256dh / keys.auth 都不能为空');
    }
    let result = {};
    try {
      result = (await store.addPushSubscription({ endpoint, keys: { p256dh, auth }, ua: str(body.ua) })) ?? {};
    } catch (err) {
      throw new HttpError(500, 'push_store_failed', `订阅保存失败：${err?.message ?? err}`);
    }
    sendJson(res, 200, {
      ok: true,
      created: result.created === true,
      total: await pushSubscriptionTotal(store),
    });
  }

  async function pushUnsubscribe({ req, res }) {
    const body = await readJsonBody(req);
    const id = str(body.id);
    const endpoint = str(body.endpoint);
    if (!id && !endpoint) {
      throw new HttpError(400, 'invalid_subscription', 'endpoint 或 id 至少给一个');
    }
    let removed = false;
    try {
      removed = (await store.removePushSubscription(id || endpoint)) === true;
    } catch (err) {
      throw new HttpError(500, 'push_store_failed', `订阅删除失败：${err?.message ?? err}`);
    }
    sendJson(res, 200, { ok: true, removed, total: await pushSubscriptionTotal(store) });
  }

  async function pushTest({ res }) {
    const instance = push();
    if (!instance) {
      sendJson(res, 200, { sent: 0, failed: 0, removed: 0, total: 0, disabled: true });
      return;
    }
    const result = await instance.send({ title: '来自待办台的测试推送', body: '能看到这条，说明手机上的订阅是通的。', url: '/' });
    sendJson(res, 200, {
      sent: num(result.sent),
      failed: num(result.failed),
      removed: num(result.removed),
      total: num(result.total),
      ...(result.disabled ? { disabled: true } : {}),
    });
  }

  async function pushRemind({ res }) {
    const instance = push();
    if (!instance) {
      sendJson(res, 200, { skipped: true, reason: 'nothing-due' });
      return;
    }
    // remind 只看标题/截止/状态，不需要完整 todo，limit 拉满即可
    const listed = (await store.listTodos({ status: 'pending', limit: 1000 })) ?? {};
    const todos = Array.isArray(listed.items) ? listed.items : [];
    const reminder = await instance.remind({ todos, now: Date.now() });
    if (!reminder) {
      sendJson(res, 200, { skipped: true, reason: 'nothing-due' });
      return;
    }
    const result = await instance.send({ title: reminder.title, body: reminder.body, url: '/' });
    sendJson(res, 200, {
      sent: num(result.sent),
      failed: num(result.failed),
      removed: num(result.removed),
      total: num(result.total),
      title: reminder.title,
      count: reminder.count,
      ...(result.disabled ? { disabled: true } : {}),
    });
  }

  // 图片读的是 DATA_DIR/images 下的单层文件名：只认白名单字符，且拒绝 . / .. 这类相对段。
  // 参数已由路由层 decodeURIComponent，所以 %2f、%2e%2e 到这里已经是明文 / 与 ..，一并拦掉。
  async function image({ res, params }) {
    const raw = str(params?.[0]);
    const nameOk = /^[A-Za-z0-9._-]{1,120}$/.test(raw) && raw !== '.' && raw !== '..' && !raw.includes('..');
    if (!nameOk) throw new HttpError(400, 'bad_request', '图片名不合法');
    const dir = path.join(store.dataDir, 'images');
    const file = path.join(dir, raw);
    // 兜底：即便正则被将来的改动放宽，也不允许解析结果跳出 images 目录
    if (path.dirname(file) !== dir) throw new HttpError(400, 'bad_request', '图片名不合法');
    let info = null;
    try {
      info = await stat(file);
    } catch {
      info = null;
    }
    if (!info || !info.isFile()) throw new HttpError(404, 'not_found', '图片不存在');
    const type = IMAGE_MIME[path.extname(raw).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      // 图片内容按 hash 命名、不会变，但它是私有数据，只能进浏览器私有缓存
      'cache-control': 'private, max-age=86400',
    });
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async function seed({ req, res }) {
    const body = await readJsonBody(req);
    // count 省略/为 0 时交给 mock 的 DEFAULT_TOTAL，别再让两处默认值各说各话
    const count = readInt(body.count, 0, 0, 5000, 'count');
    const result = (await deps.seed.run(count)) ?? {};
    sendJson(res, 200, { runId: result.runId ?? makeRunId(), imported: num(result.imported) });
  }

  const routes = [
    { method: 'GET', pattern: /^\/api\/health$/, run: health },
    { method: 'GET', pattern: /^\/api\/messages$/, run: listMessages },
    { method: 'POST', pattern: /^\/api\/ingest$/, run: ingest },
    { method: 'POST', pattern: /^\/api\/extract$/, run: extract },
    { method: 'GET', pattern: /^\/api\/todos$/, run: listTodos },
    { method: 'GET', pattern: /^\/api\/todos\/([^/]+)$/, run: getTodo },
    { method: 'PATCH', pattern: /^\/api\/todos\/([^/]+)$/, run: patchTodo },
    { method: 'POST', pattern: /^\/api\/todos\/bulk$/, run: bulkTodos },
    { method: 'GET', pattern: /^\/api\/calendar\.ics$/, run: calendar },
    { method: 'GET', pattern: /^\/api\/export\.csv$/, run: exportCsv },
    { method: 'GET', pattern: /^\/api\/decisions$/, run: decisions },
    { method: 'GET', pattern: /^\/api\/groups$/, run: groups },
    { method: 'PATCH', pattern: /^\/api\/groups\/([^/]+)$/, run: patchGroup },
    { method: 'GET', pattern: /^\/api\/stats$/, run: stats },
    { method: 'GET', pattern: /^\/api\/live$/, run: live },
    { method: 'GET', pattern: /^\/api\/push\/key$/, run: pushKey },
    { method: 'POST', pattern: /^\/api\/push\/subscribe$/, run: pushSubscribe },
    { method: 'POST', pattern: /^\/api\/push\/unsubscribe$/, run: pushUnsubscribe },
    { method: 'POST', pattern: /^\/api\/push\/test$/, run: pushTest },
    { method: 'POST', pattern: /^\/api\/push\/remind$/, run: pushRemind },
    { method: 'GET', pattern: /^\/api\/images\/([^/]+)$/, run: image },
    { method: 'POST', pattern: /^\/api\/seed$/, run: seed },
  ];

  return async function handleApi({ req, res, url }) {
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    let pathMatched = false;
    for (const route of routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      let params = match.slice(1).map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          throw new HttpError(400, 'bad_request', '路径参数编码不合法');
        }
      });
      await route.run({ req, res, url, params });
      return;
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', `${req.method} 不支持该路径`);
    throw new HttpError(404, 'not_found', '接口不存在');
  };
}
