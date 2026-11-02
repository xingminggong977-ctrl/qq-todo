// 唯一的数据出入口：<DATA_DIR>/store.json + 进程内串行写队列 + 原子替换。
// 别的模块一律不准直接碰文件（SPEC §1）。
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { looksLikeNoise, makeMessageId, normalizeKind, toBeijingISO } from "./shared/message.js";
import { daysLeft } from "./shared/time.js";

const STATE_VERSION = 1;
const MAX_RUNS = 50;
const MAX_DUPLICATES = 5;
const MAX_DECISIONS = 2000;
const MAX_ATTACHMENT_FILE = 512;
// 浏览器订阅一人可能装多台设备，20 条够用；超了按 createdAt 淘汰最旧的
const MAX_PUSH_SUBSCRIPTIONS = 20;
const TODO_STATUSES = new Set(["pending", "done", "dismissed"]);
// 决策日志的取值是封闭集合：前端按它分组，写错就是脏数据
const DECISION_VERDICTS = new Set(["todo", "dropped", "noise", "implicit", "error"]);
const GROUP_MODES = new Set(["normal", "quiet", "blocked"]);

function emptyState() {
  // totalDropped 是跨轮累计的持久化计数器：runs 只留最近 MAX_RUNS 条，
  // 每次拿截断后的 runs 重算会越算越小，所以单独计数。
  return {
    version: STATE_VERSION,
    messages: [],
    todos: [],
    runs: [],
    corrections: [],
    totalDropped: 0,
    // 每条消息一条判定记录，答「这条为什么没变成待办」
    decisions: [],
    // { [群名]: { mode, note } }，缺省视为 normal
    groupSettings: {},
    // Web Push 订阅（浏览器端 subscribe 出来的 endpoint + keys）
    pushSubscriptions: [],
  };
}

function cloneMessage(m) {
  return {
    ...m,
    attachment: m.attachment ? { ...m.attachment } : null,
    // 老 store.json 没有该键时也补 null，避免前端 JSON.stringify 丢键
    attachmentFile: normalizeAttachmentFile(m.attachmentFile),
    // 图片本地绝对路径：判定前要拿它去视觉识别，丢了就等于图片消息永远读不出字
    imageFile: normalizeAttachmentFile(m.imageFile),
  };
}

function cloneTodo(t) {
  return {
    ...t,
    constraints: Array.isArray(t.constraints) ? [...t.constraints] : [],
    duplicates: Array.isArray(t.duplicates) ? t.duplicates.map((d) => ({ ...d })) : [],
    source: { ...(t.source || {}) },
  };
}

function cloneRun(r) {
  return { ...r };
}

function byTsDesc(a, b) {
  if (a.ts === b.ts) return 0;
  return a.ts < b.ts ? 1 : -1;
}

function byTsAsc(a, b) {
  if (a.ts === b.ts) return 0;
  return a.ts < b.ts ? -1 : 1;
}

function byDeadlineAsc(a, b) {
  if (!a.deadline && !b.deadline) return byTsDesc(a, b);
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  if (a.deadline === b.deadline) return byTsDesc(a, b);
  return a.deadline < b.deadline ? -1 : 1;
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDuplicates(list) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && typeof d === "object")
    .slice(-MAX_DUPLICATES)
    .map((d) => ({
      groupName: String(d.groupName ?? ""),
      messageId: String(d.messageId ?? ""),
      at: String(d.at ?? ""),
    }));
}

function normalizeDecision(entry = {}) {
  const verdict = String(entry.verdict ?? "");
  const confidence = Number(entry.confidence);
  return {
    messageId: String(entry.messageId ?? ""),
    groupName: String(entry.groupName ?? ""),
    at: toBeijingISO(entry.at) || String(entry.at ?? ""),
    // 未知 verdict 归到 error：宁可标成「判定出了意外」，也不静默丢记录
    verdict: DECISION_VERDICTS.has(verdict) ? verdict : "error",
    reason: String(entry.reason ?? "").slice(0, 300),
    model: entry.model ? String(entry.model) : null,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
    todoId: entry.todoId ? String(entry.todoId) : null,
  };
}

function normalizeGroupSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, cfg] of Object.entries(raw)) {
    const groupName = String(name).trim();
    if (!groupName) continue;
    const mode = String(cfg?.mode ?? "normal");
    if (!GROUP_MODES.has(mode)) continue;
    const entry = { mode };
    if (cfg?.note) entry.note = String(cfg.note).slice(0, 200);
    out[groupName] = entry;
  }
  return out;
}

// Web Push 订阅：幂等键是 endpoint（同一个浏览器重复订阅只更新 keys/ua），
// id 跟 messageId 一样带前缀，方便日志里一眼认出是哪种记录。
function pushSubscriptionId(endpoint) {
  return `push_${createHash("sha1").update(String(endpoint)).digest("hex").slice(0, 12)}`;
}

function normalizePushKeys(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p256dh = typeof raw.p256dh === "string" ? raw.p256dh.trim() : "";
  const auth = typeof raw.auth === "string" ? raw.auth.trim() : "";
  if (!p256dh || !auth) return null;
  return { p256dh, auth };
}

function normalizePushSubscription(raw = {}) {
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const keys = normalizePushKeys(raw.keys);
  if (!endpoint || !keys) return null;
  const createdAt = toBeijingISO(raw.createdAt) || toBeijingISO(Date.now()) || "";
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : pushSubscriptionId(endpoint),
    endpoint,
    keys,
    ua: typeof raw.ua === "string" ? raw.ua.slice(0, 300) : "",
    createdAt,
    updatedAt: toBeijingISO(raw.updatedAt) || createdAt,
  };
}

function clonePushSubscription(item) {
  return { ...item, keys: { ...item.keys } };
}

// 推后到某天 = 那天零点解冻（判定用 Date.parse(...) > now），不是 23:59——别当 bug 改掉
function normalizeSnoozeValue(until) {
  if (until === null || until === undefined || until === "") return null;
  const text = String(until).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00+08:00`) : Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error("invalid_snooze");
  return text;
}

function isSnoozed(todo, nowMs) {
  if (!todo?.snoozedUntil) return false;
  const ms = Date.parse(todo.snoozedUntil);
  return Number.isFinite(ms) && ms > nowMs;
}

// 推后的待办仍留在列表里（前端要分组展示），但一定排在后面
function byDeadlineSnoozeLast(a, b, nowMs) {
  const sa = isSnoozed(a, nowMs);
  const sb = isSnoozed(b, nowMs);
  if (sa !== sb) return sa ? 1 : -1;
  return byDeadlineAsc(a, b);
}

function normalizeState(raw) {
  const state = emptyState();
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.messages)) state.messages = raw.messages.filter((m) => m && m.id).sort(byTsAsc);
    // 老 store.json 没有 duplicates / snoozedUntil：读盘时就补齐，别让下游到处判 undefined
    if (Array.isArray(raw.todos)) {
      state.todos = raw.todos.filter((t) => t && t.id).map((t) => ({
        ...t,
        duplicates: normalizeDuplicates(t.duplicates),
        snoozedUntil: typeof t.snoozedUntil === "string" && t.snoozedUntil.trim() ? t.snoozedUntil : null,
      }));
    }
    if (Array.isArray(raw.runs)) state.runs = raw.runs.filter((r) => r && r.id).slice(-MAX_RUNS);
    if (Array.isArray(raw.corrections)) state.corrections = raw.corrections.filter((c) => c && c.id);
    // 老 store.json 没有决策日志 / 群设置：读盘补空，别让下游到处判 undefined
    if (Array.isArray(raw.decisions)) {
      state.decisions = raw.decisions.filter((d) => d && d.messageId).slice(-MAX_DECISIONS).map(normalizeDecision);
    }
    state.groupSettings = normalizeGroupSettings(raw.groupSettings);
    // 老 store.json 没有推送订阅：读盘补空数组；残缺条目（没 endpoint 或没 keys）直接丢
    if (Array.isArray(raw.pushSubscriptions)) {
      const byEndpoint = new Map();
      for (const item of raw.pushSubscriptions) {
        const sub = normalizePushSubscription(item);
        if (sub) byEndpoint.set(sub.endpoint, sub);
      }
      state.pushSubscriptions = [...byEndpoint.values()].slice(-MAX_PUSH_SUBSCRIPTIONS);
    }
    // 旧数据没有计数器：用现存 runs 里能看到的 droppedCount 做一次性基线（缺失字段按 0），
    // 之后只由 addRun 递增，不再重算。
    state.totalDropped = Math.max(
      0,
      numOr(
        raw.totalDropped,
        state.runs.reduce((sum, r) => sum + Math.max(0, numOr(r.droppedCount, 0)), 0)
      )
    );
  }
  return state;
}

export function dedupById(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item) continue;
    const id = item.id;
    if (!id) {
      out.push(item);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

// 附件本地路径只在「非空字符串且 ≤512 字」时保留：这是管道（poller）给的提示，不是可信输入，
// 但 store 不做存在性校验——那是 live 层的事；不合法一律 null，别让脏值把落库撑大或污染 id
function normalizeAttachmentFile(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_ATTACHMENT_FILE) return null;
  return text;
}

function normalizeMessage(input = {}) {
  const groupName = String(input.groupName ?? "");
  const sender = String(input.sender ?? "");
  const text = String(input.text ?? "");
  const ts = toBeijingISO(input.ts) || String(input.ts ?? "");
  const attachment = input.attachment
    ? { name: String(input.attachment.name ?? ""), size: input.attachment.size ?? null }
    : null;
  const kind = normalizeKind(text, attachment);
  return {
    id: String(input.id || makeMessageId(groupName, ts, sender, text)),
    groupName,
    sender,
    ts,
    kind: input.kind && ["text", "file", "image", "reply", "at_all", "mixed"].includes(input.kind) ? input.kind : kind,
    text,
    attachment,
    // 附件本地绝对路径：判定前拼正文要用，丢了就等于附件功能永远不触发
    attachmentFile: normalizeAttachmentFile(input.attachmentFile),
    // 图片本地绝对路径：同上，图片消息要靠它做视觉识别
    imageFile: normalizeAttachmentFile(input.imageFile),
    source: String(input.source ?? "manual"),
    // 噪声标记按同一套规则兜底，避免导入/直播/seed 三处口径不一；
    // 带附件/带图的必须有内容要读，一律不算闲聊（否则图片通知会被入库直接短路掉）
    noise:
      normalizeAttachmentFile(input.attachmentFile) || normalizeAttachmentFile(input.imageFile)
        ? false
        : input.noise === undefined
          ? looksLikeNoise(text, kind)
          : Boolean(input.noise),
    raw: String(input.raw ?? text),
  };
}

// 标题归一化：同一件事在不同群里换了措辞/前后缀，合并时要能认出是同一行台账
export function normalizeTitle(title) {
  return String(title ?? "")
    .replace(/[【\[][^】\]]*[】\]]/g, "")
    .replace(/@全体成员/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function todoTitleKey(todo) {
  return `${todo.source?.groupName || ""}|${normalizeTitle(todo.title)}`;
}

// 跨群同通知去重键：标题 + 截止日。deadline 不同绝不合并（那是两件事）
function dedupeKey(todo) {
  return `${normalizeTitle(todo.title)}|${todo.deadline || ""}`;
}

function normalizeTodo(input = {}) {
  const now = toBeijingISO(Date.now());
  const status = TODO_STATUSES.has(input.status) ? input.status : "pending";
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(input.deadline ?? "")) ? String(input.deadline) : null;
  const constraints = (Array.isArray(input.constraints) ? input.constraints : [])
    .filter((c) => typeof c === "string" && c.trim())
    .slice(0, 3)
    .map((c) => c.trim().slice(0, 14));
  const source = input.source && typeof input.source === "object" ? input.source : {};
  return {
    id: String(input.id || `t_${randomBytes(6).toString("hex")}`),
    messageId: String(input.messageId ?? ""),
    title: String(input.title ?? "").trim().slice(0, 30),
    deadline,
    deadlineText: input.deadlineText ? String(input.deadlineText).slice(0, 20) : null,
    constraints,
    confidence: Math.min(1, Math.max(0, numOr(input.confidence, 0))),
    reason: String(input.reason ?? "").trim().slice(0, 40),
    status,
    source: {
      groupName: String(source.groupName ?? ""),
      sender: String(source.sender ?? ""),
      ts: String(source.ts ?? ""),
    },
    model: String(input.model ?? ""),
    duplicates: normalizeDuplicates(input.duplicates),
    snoozedUntil: typeof input.snoozedUntil === "string" && input.snoozedUntil.trim() ? input.snoozedUntil.trim() : null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    doneAt: status === "done" ? input.doneAt || now : null,
    dismissedAt: status === "dismissed" ? input.dismissedAt || now : null,
  };
}

// 合并只补强那条台账，绝不动 id/messageId/createdAt/status（用户已经处理过的结果优先）
function mergeIntoTodo(existing, incoming, messageId) {
  existing.updatedAt = toBeijingISO(Date.now());
  existing.confidence = Math.max(numOr(existing.confidence, 0), numOr(incoming.confidence, 0));
  existing.mergedCount = numOr(existing.mergedCount, 1) + 1;
  if (!Array.isArray(existing.mergedMessageIds)) existing.mergedMessageIds = [];
  if (messageId && !existing.mergedMessageIds.includes(messageId)) existing.mergedMessageIds.push(messageId);
  if (!existing.deadline && incoming.deadline) {
    existing.deadline = incoming.deadline;
    existing.deadlineText = incoming.deadlineText;
  }
}

// 跨群同一通知：台账不动、source 保持最初那条，只留一行「哪个群也发过」的痕迹
function recordDuplicate(existing, incoming) {
  const groupName = incoming.source?.groupName || "";
  const entry = {
    groupName,
    messageId: incoming.messageId,
    at: incoming.source?.ts || toBeijingISO(Date.now()),
  };
  const kept = normalizeDuplicates(existing.duplicates).filter((d) => d.groupName !== groupName);
  existing.duplicates = [...kept, entry].slice(-MAX_DUPLICATES);
  existing.updatedAt = toBeijingISO(Date.now());
  if (!Array.isArray(existing.mergedMessageIds)) existing.mergedMessageIds = [];
  if (incoming.messageId && !existing.mergedMessageIds.includes(incoming.messageId)) {
    existing.mergedMessageIds.push(incoming.messageId);
  }
}

export function createStore(dirOrOptions = {}) {
  const options = typeof dirOrOptions === "string" ? { dataDir: dirOrOptions } : dirOrOptions || {};
  const dataDir = path.resolve(process.cwd(), options.dataDir || process.env.DATA_DIR || "./data");
  const file = path.join(dataDir, "store.json");
  const tmpFile = `${file}.tmp`;
  const fallbackProvider = options.provider || process.env.LLM_PROVIDER || "stub";
  // 可注入 now，便于测试 snoozed 的判定（默认真实时钟）
  const nowMs = typeof options.now === "function" ? () => Number(options.now()) : () => Date.now();

  let state = null;
  let stamp = null;
  let tail = Promise.resolve();

  function fileStamp() {
    try {
      const s = statSync(file);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  }

  function readFromDisk() {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      stamp = null;
      return emptyState();
    }
    try {
      const parsed = JSON.parse(raw);
      stamp = fileStamp();
      return normalizeState(parsed);
    } catch (err) {
      // 坏文件不能让服务再也起不来：备份后重建
      try {
        renameSync(file, `${file}.bad-${Date.now()}`);
      } catch {}
      console.error(`[store] store.json 解析失败，已备份并重建：${err.message}`);
      stamp = null;
      return emptyState();
    }
  }

  function load() {
    if (!state) state = readFromDisk();
    return state;
  }

  // 别的进程（CLI）可能刚写过同一个文件，以磁盘为准再合并，避免覆盖。
  function refreshIfChanged() {
    if (!state) return;
    const now = fileStamp();
    if (!now) return;
    if (stamp && now.mtimeMs === stamp.mtimeMs && now.size === stamp.size) return;
    state = readFromDisk();
  }

  function persist() {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify(state), "utf8");
    renameSync(tmpFile, file);
    stamp = fileStamp();
  }

  function mutate(fn) {
    const run = tail.then(async () => {
      load();
      refreshIfChanged();
      const result = await fn(state);
      persist();
      return result;
    });
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function listMessages({ limit = 100, group = "", noise = "include" } = {}) {
    const s = load();
    const groups = [...new Set(s.messages.map((m) => m.groupName))].sort();
    let items = s.messages;
    if (group) items = items.filter((m) => m.groupName === group);
    if (noise === "exclude" || noise === false) items = items.filter((m) => !m.noise);
    else if (noise === "only" || noise === true) items = items.filter((m) => m.noise);
    const total = items.length;
    const sorted = items.slice().sort(byTsDesc);
    const max = numOr(limit, 100);
    const sliced = max > 0 ? sorted.slice(0, max) : sorted;
    return { items: sliced.map(cloneMessage), total, groups };
  }

  function getMessage(id) {
    const hit = load().messages.find((m) => m.id === id);
    return hit ? cloneMessage(hit) : null;
  }

  async function addMessages(messages) {
    return mutate((s) => {
      const incoming = dedupById(Array.isArray(messages) ? messages : [messages]).map(normalizeMessage);
      const known = new Set(s.messages.map((m) => m.id));
      const inserted = [];
      for (const m of incoming) {
        if (known.has(m.id)) continue;
        known.add(m.id);
        s.messages.push(m);
        inserted.push(cloneMessage(m));
      }
      s.messages.sort(byTsAsc);
      return {
        imported: inserted.length,
        skipped: incoming.length - inserted.length,
        ids: inserted.map((m) => m.id),
        inserted,
      };
    });
  }

  // 群级屏蔽在 store 层统一过滤：API / CLI / 推送看到的必须是同一份数据
  function blockedGroupNames(s = load()) {
    const out = new Set();
    for (const [name, cfg] of Object.entries(s.groupSettings || {})) {
      if (cfg?.mode === "blocked") out.add(name);
    }
    return out;
  }

  function listTodos({ status = "", limit = 200, group = "" } = {}) {
    const s = load();
    const blocked = blockedGroupNames(s);
    const visible = s.todos.filter((t) => !blocked.has(t.source?.groupName || ""));
    const stats = { pending: 0, done: 0, dismissed: 0 };
    for (const t of visible) stats[t.status] = (stats[t.status] || 0) + 1;
    let items = visible;
    if (status && status !== "all") items = items.filter((t) => t.status === status);
    if (group) items = items.filter((t) => t.source.groupName === group);
    const max = numOr(limit, 200);
    // 推后的（snoozedUntil 仍在未来）默认保留在列表里，只把顺序压到最后
    const now = nowMs();
    const sorted = items.slice().sort((a, b) => byDeadlineSnoozeLast(a, b, now));
    return { items: (max > 0 ? sorted.slice(0, max) : sorted).map(cloneTodo), stats };
  }

  function getTodo(id) {
    const hit = load().todos.find((t) => t.id === id);
    return hit ? cloneTodo(hit) : null;
  }

  async function addTodos(todos) {
    return mutate((s) => {
      const list = (Array.isArray(todos) ? todos : [todos]).filter((t) => t && typeof t === "object");
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const byMessage = new Map();
      const byId = new Map();
      const byTitleKey = new Map();
      const byDedupeKey = new Map();
      for (const t of s.todos) {
        byId.set(t.id, t);
        const key = todoTitleKey(t);
        byTitleKey.set(key, [...(byTitleKey.get(key) || []), t]);
        const dkey = dedupeKey(t);
        byDedupeKey.set(dkey, [...(byDedupeKey.get(dkey) || []), t]);
        for (const mid of [t.messageId, ...(t.mergedMessageIds || [])]) if (mid) byMessage.set(mid, t);
      }
      for (const raw of list) {
        const messageId = String(raw.messageId ?? "");
        // 没有 messageId 就没法保证「一条消息最多一条待办」，直接丢
        if (!messageId) {
          skipped += 1;
          continue;
        }
        const existing = byMessage.get(messageId) || (raw.id ? byId.get(raw.id) : null);
        if (!existing) {
          const todo = normalizeTodo(raw);
          // 只允许并进 pending 行：done/dismissed 是用户做过的决定，新一期通知是新义务，
          // 折叠进已完成行会让用户漏做事。跨群同标题也不合并——可能是不同的班级事务。
          const twin = (byTitleKey.get(todoTitleKey(todo)) || []).find((t) => t.status === "pending");
          if (twin) {
            mergeIntoTodo(twin, todo, messageId);
            byMessage.set(messageId, twin);
            updated += 1;
            continue;
          }
          // 同一条通知在别的群又发了一遍：不新建台账，只在原台账的 duplicates 里留痕。
          // 只认 pending：原行已 done/dismissed 时，转发算新义务，不许被旧行吸收。
          const dkey = dedupeKey(todo);
          const crossGroup = (byDedupeKey.get(dkey) || []).filter(
            (t) => (t.source?.groupName || "") !== (todo.source?.groupName || ""),
          );
          const dup = crossGroup.find((t) => t.status === "pending");
          if (dup) {
            recordDuplicate(dup, todo);
            byMessage.set(messageId, dup);
            updated += 1;
            continue;
          }
          todo.mergedCount = 1;
          s.todos.push(todo);
          byMessage.set(todo.messageId, todo);
          byId.set(todo.id, todo);
          const key = todoTitleKey(todo);
          byTitleKey.set(key, [...(byTitleKey.get(key) || []), todo]);
          byDedupeKey.set(dkey, [...(byDedupeKey.get(dkey) || []), todo]);
          created += 1;
          continue;
        }
        // 重复抽取只更新模型产出，用户的 status/时间戳不覆盖；dup 痕迹与 snooze 也不许被清掉
        const patch = normalizeTodo({
          ...raw,
          id: existing.id,
          status: existing.status,
          createdAt: existing.createdAt,
          doneAt: existing.doneAt,
          dismissedAt: existing.dismissedAt,
          duplicates: existing.duplicates,
          snoozedUntil: existing.snoozedUntil,
        });
        Object.assign(existing, patch);
        updated += 1;
      }
      return { created, updated, skipped };
    });
  }

  async function setTodoStatus(id, status) {
    if (!TODO_STATUSES.has(status)) throw new Error(`未知的待办状态：${status}`);
    return mutate((s) => {
      const todo = s.todos.find((t) => t.id === id);
      if (!todo) return null;
      const now = toBeijingISO(Date.now());
      todo.status = status;
      todo.updatedAt = now;
      todo.doneAt = status === "done" ? now : null;
      todo.dismissedAt = status === "dismissed" ? now : null;
      return cloneTodo(todo);
    });
  }

  // 批量改状态：UI 多选后一次落盘。未知 id 不算错误（可能刚被别处删掉），计入 skipped。
  async function setTodoStatusMany(ids, status) {
    if (!TODO_STATUSES.has(status)) throw new Error("invalid_status");
    const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? "").trim()).filter(Boolean))];
    if (wanted.length === 0) return { updated: 0, skipped: 0 };
    return mutate((s) => {
      const byId = new Map(s.todos.map((t) => [t.id, t]));
      const now = toBeijingISO(nowMs());
      let updated = 0;
      for (const id of wanted) {
        const todo = byId.get(id);
        if (!todo) continue;
        if (todo.status === status) continue; // 已经是这个状态：算 skipped，不刷 updatedAt
        todo.status = status;
        todo.updatedAt = now;
        todo.doneAt = status === "done" ? now : null;
        todo.dismissedAt = status === "dismissed" ? now : null;
        updated += 1;
      }
      return { updated, skipped: wanted.length - updated };
    });
  }

  // 手动设/清截止日：只改 deadline，不动 deadlineText（那是群里原话，留作溯源）
  async function setTodoDeadline(id, deadline) {
    const text = deadline === null || deadline === undefined ? "" : String(deadline).trim();
    if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("invalid_deadline");
    return mutate((s) => {
      const todo = s.todos.find((t) => t.id === id);
      if (!todo) return null;
      todo.deadline = text || null;
      todo.deadlineManual = Boolean(text);
      todo.updatedAt = toBeijingISO(nowMs());
      return cloneTodo(todo);
    });
  }

  // 推后：只改 snoozedUntil（null 表示取消推后），不做任何状态迁移
  async function snoozeTodo(id, until) {
    const value = normalizeSnoozeValue(until);
    return mutate((s) => {
      const todo = s.todos.find((t) => t.id === id);
      if (!todo) return null;
      todo.snoozedUntil = value;
      todo.updatedAt = toBeijingISO(nowMs());
      return cloneTodo(todo);
    });
  }

  function listRuns(limit = MAX_RUNS) {
    const s = load();
    const max = numOr(limit, MAX_RUNS);
    return s.runs
      .slice()
      .sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1))
      .slice(0, max > 0 ? max : undefined)
      .map(cloneRun);
  }

  async function addRun(run = {}) {
    return mutate((s) => {
      const now = toBeijingISO(Date.now());
      const record = {
        id: String(run.id || `r_${randomBytes(4).toString("hex")}`),
        kind: run.kind === "extract" ? "extract" : "ingest",
        startedAt: run.startedAt || now,
        finishedAt: run.finishedAt || now,
        imported: numOr(run.imported, 0),
        skipped: numOr(run.skipped, 0),
        processed: numOr(run.processed, 0),
        todos: numOr(run.todos ?? run.todosCreated, 0),
        errors: numOr(run.errors, 0),
        provider: String(run.provider || fallbackProvider),
        costUsd: numOr(run.costUsd, 0),
        droppedCount: Math.max(0, numOr(run.droppedCount, 0)),
        modelCalls: Math.max(0, numOr(run.modelCalls, 0)),
        // 视觉识图用量：轮次记录里要能看出「这轮读了几张图」，排查漏判时是唯一线索
        visionUsed: Math.max(0, numOr(run.visionUsed, 0)),
        visionSkipped: Math.max(0, numOr(run.visionSkipped, 0)),
        visionFailed: Math.max(0, numOr(run.visionFailed, 0)),
      };
      s.runs.push(record);
      if (s.runs.length > MAX_RUNS) s.runs = s.runs.slice(-MAX_RUNS);
      s.totalDropped = Math.max(0, numOr(s.totalDropped, 0)) + record.droppedCount;
      return cloneRun(record);
    });
  }

  function listCorrections() {
    return load().corrections.slice().map((c) => ({ ...c }));
  }

  async function appendCorrection(entry = {}) {
    return mutate((s) => {
      const record = {
        id: String(entry.id || `c_${randomBytes(4).toString("hex")}`),
        todoTitle: String(entry.todoTitle ?? "").slice(0, 60),
        messageText: String(entry.messageText ?? ""),
        createdAt: entry.createdAt || toBeijingISO(Date.now()),
      };
      s.corrections.push(record);
      return { ...record };
    });
  }

  function counts() {
    const s = load();
    const blocked = blockedGroupNames(s);
    const out = {
      messages: s.messages.length,
      noise: 0,
      todos: 0,
      pending: 0,
      done: 0,
      dismissed: 0,
      snoozed: 0,
    };
    const now = nowMs();
    for (const m of s.messages) if (m.noise) out.noise += 1;
    for (const t of s.todos) {
      if (blocked.has(t.source?.groupName || "")) continue;
      out.todos += 1;
      out[t.status] = (out[t.status] || 0) + 1;
      if (t.status === "pending" && isSnoozed(t, now)) out.snoozed += 1;
    }
    return out;
  }

  function getStats() {
    const s = load();
    const c = counts();
    const blocked = blockedGroupNames(s);
    const visibleTodos = s.todos.filter((t) => !blocked.has(t.source?.groupName || ""));
    const runs = s.runs.filter((r) => r.kind === "extract");
    const lastExtract = runs.length
      ? runs.slice().sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1))[0]
      : null;
    // SPEC §4 示例里 messagesProcessed(273) 大于 counts.messages(220)，即跨 run 累加
    const messagesProcessed = runs.reduce((sum, r) => sum + numOr(r.processed, 0), 0);

    const groupOrder = new Map();
    for (const m of s.messages) groupOrder.set(m.groupName, (groupOrder.get(m.groupName) || 0) + 1);
    const byGroup = [...groupOrder.entries()]
      .map(([groupName, messages]) => ({
        groupName,
        messages,
        todos: visibleTodos.filter((t) => t.source.groupName === groupName).length,
        mode: s.groupSettings?.[groupName]?.mode || "normal",
      }))
      .sort((a, b) => b.messages - a.messages);

    // 推后的、被屏蔽的群产出的东西都不该出现在「即将到期」里
    const now = nowMs();
    const dueSoon = visibleTodos
      .filter((t) => t.status === "pending" && t.deadline && !isSnoozed(t, now))
      .sort(byDeadlineAsc)
      .slice(0, 5)
      .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, daysLeft: daysLeft(t.deadline) }));

    const totalDropped = Math.max(0, numOr(s.totalDropped, 0));
    const lastDropped = lastExtract ? Math.max(0, numOr(lastExtract.droppedCount, 0)) : 0;

    const byVerdict = { todo: 0, dropped: 0, noise: 0, implicit: 0, error: 0 };
    for (const d of s.decisions) byVerdict[d.verdict] = (byVerdict[d.verdict] || 0) + 1;

    return {
      counts: c,
      totalDropped,
      lastDropped,
      funnel: { messagesProcessed, todosKept: visibleTodos.length },
      provider: lastExtract ? lastExtract.provider : fallbackProvider,
      lastExtract: lastExtract ? cloneRun(lastExtract) : null,
      byGroup,
      dueSoon,
      decisions: { total: s.decisions.length, byVerdict },
      // 根级单独放，不进 counts：counts 的每个键前端都当卡片渲染
      push: { subscriptions: s.pushSubscriptions.length },
    };
  }

  // 批量写入判定记录：同一 messageId 覆盖旧记录（重跑不叠加），超 2000 条 FIFO 丢最老
  async function recordDecisions(entries) {
    const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e && typeof e === "object");
    return mutate((s) => {
      if (!Array.isArray(s.decisions)) s.decisions = [];
      const index = new Map(s.decisions.map((d, i) => [d.messageId, i]));
      let written = 0;
      for (const raw of list) {
        const entry = normalizeDecision(raw);
        if (!entry.messageId) continue;
        if (!entry.at) entry.at = toBeijingISO(nowMs());
        const hit = index.get(entry.messageId);
        if (hit === undefined) {
          s.decisions.push(entry);
          index.set(entry.messageId, s.decisions.length - 1);
        } else {
          s.decisions[hit] = entry;
        }
        written += 1;
      }
      if (s.decisions.length > MAX_DECISIONS) s.decisions = s.decisions.slice(-MAX_DECISIONS);
      return { written, total: s.decisions.length };
    });
  }

  function listDecisions({ limit = 50, verdict = "", groupName = "", messageId = "" } = {}) {
    let items = load().decisions;
    if (verdict) items = items.filter((d) => d.verdict === verdict);
    if (groupName) items = items.filter((d) => d.groupName === groupName);
    if (messageId) items = items.filter((d) => d.messageId === messageId);
    const total = items.length;
    const sorted = items.slice().sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
    const max = numOr(limit, 50);
    return { items: (max > 0 ? sorted.slice(0, max) : sorted).map((d) => ({ ...d })), total };
  }

  async function setGroupMode(groupName, mode) {
    const name = String(groupName ?? "").trim();
    if (!name) throw new Error("invalid_group");
    const next = String(mode ?? "");
    if (!GROUP_MODES.has(next)) throw new Error("invalid_mode");
    return mutate((s) => {
      if (!s.groupSettings || typeof s.groupSettings !== "object") s.groupSettings = {};
      const prev = s.groupSettings[name] || {};
      s.groupSettings[name] = { ...prev, mode: next };
      return { groupName: name, ...s.groupSettings[name] };
    });
  }

  function getGroupSettings() {
    const s = load();
    const out = {};
    for (const [name, cfg] of Object.entries(s.groupSettings || {})) out[name] = { ...cfg };
    return out;
  }

  // 浏览器 Web Push 订阅：同一 endpoint 重复提交只更新 keys/ua，不新增行
  async function addPushSubscription({ endpoint, keys, ua = "" } = {}) {
    const url = typeof endpoint === "string" ? endpoint.trim() : "";
    const keyPair = normalizePushKeys(keys);
    if (!url || !keyPair) throw new Error("invalid_subscription");
    const id = pushSubscriptionId(url);
    return mutate((s) => {
      if (!Array.isArray(s.pushSubscriptions)) s.pushSubscriptions = [];
      const existing = s.pushSubscriptions.find((item) => item.endpoint === url);
      if (existing) {
        existing.keys = keyPair;
        if (typeof ua === "string" && ua.trim()) existing.ua = ua.trim().slice(0, 300);
        existing.updatedAt = toBeijingISO(nowMs()) || existing.updatedAt;
        return { created: false, id: existing.id };
      }
      const at = toBeijingISO(nowMs()) || "";
      s.pushSubscriptions.push({ id, endpoint: url, keys: keyPair, ua: typeof ua === "string" ? ua.trim().slice(0, 300) : "", createdAt: at, updatedAt: at });
      if (s.pushSubscriptions.length > MAX_PUSH_SUBSCRIPTIONS) {
        // FIFO：留最新的 MAX 条，不是按提交顺序而是按创建时间
        s.pushSubscriptions = s.pushSubscriptions
          .slice()
          .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1))
          .slice(-MAX_PUSH_SUBSCRIPTIONS);
      }
      return { created: true, id };
    });
  }

  // ref 可以是 id，也可以是 endpoint（前端手上通常只有其中一种）
  async function removePushSubscription(ref) {
    const key = typeof ref === "string" ? ref.trim() : "";
    if (!key) return false;
    return mutate((s) => {
      if (!Array.isArray(s.pushSubscriptions)) s.pushSubscriptions = [];
      const before = s.pushSubscriptions.length;
      s.pushSubscriptions = s.pushSubscriptions.filter((item) => item.id !== key && item.endpoint !== key);
      return s.pushSubscriptions.length !== before;
    });
  }

  function listPushSubscriptions() {
    return { items: load().pushSubscriptions.map(clonePushSubscription) };
  }

  async function reset() {
    return mutate((s) => {
      const fresh = emptyState();
      for (const key of Object.keys(s)) delete s[key];
      Object.assign(s, fresh);
      return { ok: true };
    });
  }

  async function flush() {
    await tail;
  }

  return {
    dataDir,
    file,
    listMessages,
    getMessage,
    addMessages,
    upsertMessages: addMessages,
    dedupById,
    listTodos,
    getTodo,
    addTodos,
    upsertTodos: addTodos,
    setTodoStatus,
    patchTodoStatus: setTodoStatus,
    setTodoStatusMany,
    snoozeTodo,
    setTodoDeadline,
    listRuns,
    addRun,
    appendRun: addRun,
    listCorrections,
    appendCorrection,
    counts,
    getStats,
    stats: getStats,
    recordDecisions,
    listDecisions,
    setGroupMode,
    getGroupSettings,
    addPushSubscription,
    removePushSubscription,
    listPushSubscriptions,
    reset,
    flush,
  };
}

let defaultStore = null;

export function configure(dirOrOptions) {
  defaultStore = createStore(dirOrOptions);
  return defaultStore;
}

export function getStore(opts) {
  if (!defaultStore) defaultStore = createStore(opts || {});
  return defaultStore;
}

// 便捷包装：B 若 `import * as store` 也能直接用。
export const listMessages = (...a) => getStore().listMessages(...a);
export const getMessage = (...a) => getStore().getMessage(...a);
export const addMessages = (...a) => getStore().addMessages(...a);
export const upsertMessages = (...a) => getStore().addMessages(...a);
export const listTodos = (...a) => getStore().listTodos(...a);
export const getTodo = (...a) => getStore().getTodo(...a);
export const addTodos = (...a) => getStore().addTodos(...a);
export const upsertTodos = (...a) => getStore().addTodos(...a);
export const setTodoStatus = (...a) => getStore().setTodoStatus(...a);
export const patchTodoStatus = (...a) => getStore().setTodoStatus(...a);
export const setTodoStatusMany = (...a) => getStore().setTodoStatusMany(...a);
export const snoozeTodo = (...a) => getStore().snoozeTodo(...a);
export const listRuns = (...a) => getStore().listRuns(...a);
export const addRun = (...a) => getStore().addRun(...a);
export const appendRun = (...a) => getStore().addRun(...a);
export const listCorrections = (...a) => getStore().listCorrections(...a);
export const appendCorrection = (...a) => getStore().appendCorrection(...a);
export const counts = (...a) => getStore().counts(...a);
export const getStats = (...a) => getStore().getStats(...a);
export const stats = (...a) => getStore().getStats(...a);
export const recordDecisions = (...a) => getStore().recordDecisions(...a);
export const listDecisions = (...a) => getStore().listDecisions(...a);
export const setGroupMode = (...a) => getStore().setGroupMode(...a);
export const getGroupSettings = (...a) => getStore().getGroupSettings(...a);
export const addPushSubscription = (...a) => getStore().addPushSubscription(...a);
export const removePushSubscription = (...a) => getStore().removePushSubscription(...a);
export const listPushSubscriptions = (...a) => getStore().listPushSubscriptions(...a);
export const reset = (...a) => getStore().reset(...a);
export const flush = (...a) => getStore().flush(...a);

export default createStore;
