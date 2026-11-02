// NapCat OneBot 11 定时增量拉取器：只用查询类 API（get_group_list / get_group_msg_history），
// 只读，不发消息、不改任何 NapCat 配置。默认关闭（LIVE_POLL_ENABLED=off）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDataDir } from "../config.js";
import { buildMessage } from "./napcat.js";
import { fetchAttachment } from "./attach-fetch.js";
import { fetchImage } from "./image-fetch.js";

const DEFAULT_WS_URL = "ws://127.0.0.1:3001/";
const CURSOR_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15000;
const MIN_INTERVAL_SEC = 30;
const MAX_BACKOFF_FACTOR = 8;
const RETCODE_NOT_FOUND = 1200;
// afterEach 是「本轮入库之后再做点事」（比如触发一次提取）。它有独立看门狗：
// 超时只记一条日志，绝不改 failures（那是网络失败的口径），也不影响下一轮排期。
const AFTER_EACH_TIMEOUT_MS = 120000;
// 附件下载：一轮最多几个、总共允许多久。超了就把剩下的留到下一轮，
// 否则一个 8MB 文件乘以 10 个群会把 5 分钟的周期撑爆。
const MAX_ATTACH_PER_RUN = 5;
const ATTACH_BUDGET_MS = 30000;
// 图片下载：图片小、来得多，额度比附件宽；同样是硬预算，超了留到下一轮
const MAX_IMAGE_PER_RUN = 8;
const IMAGE_BUDGET_MS = 30000;

/** message_seq 与 message_id 在 NapCat 上未必相同：游标回传用 seq，去重用 message_id。 */
function seqOf(raw) {
  const candidates = [raw?.message_seq, raw?.real_seq, raw?.message_id];
  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

/**
 * OneBot 11 WS 动作通道：连上后在连接内发 {action, params, echo}，按 echo 配对响应。
 * 只用来调查询类 action，断开后下一次调用会重建连接。
 */
export function createNapcatWsClient({
  url = DEFAULT_WS_URL,
  token = "",
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  let socket = null;
  let ready = null;
  let counter = 0;
  const pending = new Map();

  function rejectAll(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function open() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(url, headers ? { headers } : undefined);
      socket = ws;
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", () => {
        ready = null;
        reject(new Error("NapCat WS 连接失败"));
      });
      ws.addEventListener("close", () => {
        ready = null;
        rejectAll("NapCat WS 已断开");
      });
      ws.addEventListener("message", (event) => {
        let payload;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return; // 事件帧是心跳/lifecycle 之类，拉取器不消费
        }
        const entry = payload?.echo ? pending.get(String(payload.echo)) : null;
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(String(payload.echo));
        entry.resolve(payload);
      });
    }).catch((err) => {
      ready = null;
      throw err;
    });
    return ready;
  }

  async function request(action, params = {}) {
    const ws = await open();
    const echo = `poll-${++counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`${action} 超时`));
      }, timeoutMs);
      pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch {
        clearTimeout(timer);
        pending.delete(echo);
        reject(new Error(`${action} 发送失败`));
      }
    });
  }

  function close() {
    rejectAll("NapCat WS 已关闭");
    ready = null;
    const sock = socket;
    socket = null;
    try {
      sock?.close();
    } catch {
      // 关闭失败不影响退出
    }
  }

  return { request, close };
}

function readCursor(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.groups) return parsed;
  } catch {
    // 没有游标文件是第一轮的常态
  }
  return { version: CURSOR_VERSION, groups: {} };
}

function writeCursor(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, file);
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function startPoller({
  env = {},
  store,
  request,
  log = console.log,
  now = () => Date.now(),
  afterEach,
  autoStart = true,
  fetchAttachmentImpl = fetchAttachment,
  fetchImageImpl = fetchImage,
} = {}) {
  const enabled = /^(on|1|true)$/i.test(String(env.LIVE_POLL_ENABLED ?? "").trim());
  const intervalSec = toInt(env.LIVE_POLL_INTERVAL_SEC, 300, MIN_INTERVAL_SEC, 86400);
  const maxPerGroup = toInt(env.LIVE_POLL_MAX_PER_GROUP, 50, 1, 200);
  const dataDir = resolveDataDir(env);
  const cursorFile = path.join(dataDir, "live-poll.json");

  let closeClient = () => {};
  if (typeof request !== "function") {
    const client = createNapcatWsClient({
      url: String(env.NAPCAT_WS_URL || DEFAULT_WS_URL).trim() || DEFAULT_WS_URL,
      token: String(env.NAPCAT_ACCESS_TOKEN ?? "").trim(),
    });
    request = client.request;
    closeClient = client.close;
  }

  let cursor = readCursor(cursorFile);
  let failures = 0;
  let running = false;
  let stopped = false;
  let timer = null;
  let nextDelayMs = intervalSec * 1000;
  let lastRunAt = null;
  let lastResult = null;
  let lastAfterEach = { at: null, ok: null, error: null };
  let afterEachBusy = false;
  let afterEachController = null;
  let afterEachWatchdog = null;
  let resolveReady = () => {};
  let readySettled = false;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function settleReady(payload) {
    if (readySettled) return;
    readySettled = true;
    resolveReady(payload);
  }

  function saveCursor() {
    try {
      writeCursor(cursorFile, cursor);
    } catch (err) {
      log("[poll] 游标写入失败：", err?.message ?? err);
    }
  }

  async function fetchPage(groupId, beforeSeq) {
    const params = { group_id: groupId, count: maxPerGroup };
    if (beforeSeq !== null && beforeSeq !== undefined) params.message_seq = beforeSeq;
    return request("get_group_msg_history", params);
  }

  // 附件接线：只给 kind==='file' 且解析出 file_id 的消息补 attachmentFile（绝对路径）。
  // 失败一律软跳过——轮询器的成功与否只由「拉取 + 入库」决定。
  async function attachFiles(messages, { groupId, userId, kind, ctx, result }) {
    for (const message of messages) {
      if (message.kind !== "file") continue;
      const fileId = String(message.attachment?.fileId ?? "").trim();
      if (!fileId) continue;
      if (ctx.downloaded >= MAX_ATTACH_PER_RUN) {
        log(`[attach] 本轮已下载 ${ctx.downloaded} 个，剩余留到下一轮`);
        break;
      }
      if (now() - ctx.startedAt > ATTACH_BUDGET_MS) {
        log(`[attach] 本轮下载已用满 ${Math.round(ATTACH_BUDGET_MS / 1000)}s，剩余留到下一轮`);
        break;
      }

      let outcome = ctx.cache.get(fileId);
      if (!outcome) {
        ctx.downloaded += 1;
        try {
          outcome = await fetchAttachmentImpl({
            callApi: request,
            kind,
            groupId,
            userId,
            fileId,
            busid: message.attachment?.busid ?? null,
            name: message.attachment?.name ?? "",
            dataDir,
          });
        } catch (err) {
          outcome = { ok: false, path: null, bytes: 0, reason: `下载器异常：${err?.message ?? err}` };
        }
        ctx.cache.set(fileId, outcome);
      }

      if (outcome?.ok && outcome.path) {
        message.attachmentFile = outcome.path;
        result.attachments += 1;
        continue;
      }
      log(`[attach] skip ${message.attachment?.name || fileId}: ${outcome?.reason ?? "未知原因"}`);
    }
  }

  // 图片接线：只给 kind==='image' 且有 image 元数据的消息补 imageFile（绝对路径）。
  // 与 attachFiles 同构：预算独立、同轮同 id 只下一次、失败软跳过。
  async function attachImages(messages, { ctx, result }) {
    for (const message of messages) {
      if (message.kind !== "image" || !message.image) continue;
      const key = String(message.image.fileId || message.image.file || message.image.url || "").trim();
      if (!key) continue;
      if (ctx.images >= MAX_IMAGE_PER_RUN) {
        log(`[image] 本轮已下载 ${ctx.images} 张，剩余留到下一轮`);
        break;
      }
      if (now() - ctx.startedAt > IMAGE_BUDGET_MS) {
        log(`[image] 本轮图片下载已用满 ${Math.round(IMAGE_BUDGET_MS / 1000)}s，剩余留到下一轮`);
        break;
      }

      let outcome = ctx.imageCache.get(key);
      if (!outcome) {
        ctx.images += 1;
        try {
          outcome = await fetchImageImpl({ callApi: request, message, dataDir });
        } catch (err) {
          outcome = { ok: false, path: null, bytes: 0, reason: `下载器异常：${err?.message ?? err}` };
        }
        ctx.imageCache.set(key, outcome);
      }

      if (outcome?.ok && outcome.path) {
        message.imageFile = outcome.path;
        result.images += 1;
        continue;
      }
      log(`[image] skip ${key}: ${outcome?.reason ?? "未知原因"}`);
    }
  }

  async function pollGroup(group, ctx) {
    const groupId = group?.group_id;
    const groupName = String(group?.group_name || groupId || "").trim();
    const known = cursor.groups[String(groupId)];
    const result = { groupId, groupName, processed: 0, inserted: 0, skipped: 0, attachments: 0, images: 0, error: null };

    let page;
    try {
      page = await fetchPage(groupId, known?.seq);
    } catch (err) {
      result.error = err?.message ?? String(err);
      return result;
    }
    if (Number(page?.retcode ?? 0) === RETCODE_NOT_FOUND) return result; // 空群/无权限：不算失败
    if (Number(page?.retcode ?? 0) !== 0 || page?.status === "failed") {
      result.error = `retcode=${page?.retcode ?? "?"}`;
      return result;
    }

    const rawList = Array.isArray(page?.data?.messages) ? page.data.messages : [];
    result.processed = rawList.length;
    // 传 message_seq 时返回页首就是游标那条，跳过它；其余靠 store 按 id 二次去重。
    const fresh = rawList.filter((raw) => {
      if (known?.seq === null || known?.seq === undefined) return true;
      return String(seqOf(raw)) !== String(known.seq);
    });
    if (fresh.length === 0) return result;

    const messages = [];
    for (const raw of fresh) {
      const message = buildMessage(raw, String(raw?.group_name || groupName || ""));
      if (!message.groupName) continue;
      messages.push(message);
    }
    result.skipped = fresh.length - messages.length;

    if (messages.length > 0) {
      await attachFiles(messages, { groupId, kind: "group", ctx, result });
      await attachImages(messages, { ctx, result });
      const added = await store.addMessages(messages);
      result.inserted = Number(added?.imported ?? 0);
      result.skipped += Number(added?.skipped ?? 0);
    }

    const newest = fresh[fresh.length - 1];
    const newestSeq = seqOf(newest);
    if (newestSeq !== null) {
      cursor.groups[String(groupId)] = {
        seq: newestSeq,
        messageId: newest?.message_id ?? null,
        groupName,
        updatedAt: new Date(now()).toISOString(),
      };
    }
    return result;
  }

  // 触发式后处理：游标已落盘、ready 已结算之后调用，永不阻塞调度。
  // 传 { signal } 给回调，stop() 时 abort；看门狗只记日志不动 failures。
  function runAfterEach(summary) {
    if (typeof afterEach !== "function") return;
    if (afterEachBusy) {
      log("[poll] 上一轮 afterEach 仍在执行，跳过本轮");
      return;
    }
    const at = new Date(now()).toISOString();
    const controller = new AbortController();
    let settled = false;
    afterEachBusy = true;
    afterEachController = controller;
    lastAfterEach = { at, ok: null, error: null };

    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      if (afterEachWatchdog) {
        clearTimeout(afterEachWatchdog);
        afterEachWatchdog = null;
      }
      afterEachBusy = false;
      afterEachController = null;
      const aborted = controller.signal.aborted;
      const error = ok && !aborted ? null : String(err?.message ?? (aborted ? "已中止（stop）" : err));
      lastAfterEach = { at, ok: ok && !aborted, error: ok && !aborted ? null : error };
      if (!ok && !aborted) log(`[poll] afterEach 失败：${error}`);
    };

    afterEachWatchdog = setTimeout(() => {
      afterEachWatchdog = null;
      const err = new Error(`超时（${AFTER_EACH_TIMEOUT_MS}ms）`);
      controller.abort(err);
      finish(false, err);
    }, AFTER_EACH_TIMEOUT_MS);
    afterEachWatchdog.unref?.();

    Promise.resolve()
      .then(() => afterEach(summary, { signal: controller.signal }))
      .then(
        () => finish(true, null),
        (err) => finish(false, err),
      );
  }

  async function pollOnce() {
    if (!enabled) return { enabled: false, groups: 0, processed: 0, inserted: 0, attachments: 0, images: 0, errors: 0 };
    if (running) {
      return { enabled: true, busy: true, groups: 0, processed: 0, inserted: 0, attachments: 0, images: 0, errors: 0 };
    }
    running = true;
    const summary = { enabled: true, groups: 0, processed: 0, inserted: 0, attachments: 0, images: 0, errors: 0 };
    // 同一轮内同一 file_id / 图片句柄只下一次；预算按整轮算（跨群共享）
    const attachCtx = { cache: new Map(), downloaded: 0, startedAt: now(), imageCache: new Map(), images: 0 };

    try {
      const listed = await request("get_group_list", {});
      if (Number(listed?.retcode ?? 0) !== 0 || !Array.isArray(listed?.data)) {
        throw new Error(`get_group_list retcode=${listed?.retcode ?? "?"}`);
      }
      const groups = listed.data;
      summary.groups = groups.length;
      for (const group of groups) {
        const one = await pollGroup(group, attachCtx);
        summary.processed += one.processed;
        summary.inserted += one.inserted;
        summary.attachments += one.attachments;
        summary.images += one.images;
        if (one.error) {
          summary.errors += 1;
          log(`[poll] ${one.groupName || one.groupId} 拉取失败：${one.error}`);
        }
      }
      failures = 0;
    } catch (err) {
      summary.errors += 1;
      failures += 1;
      log("[poll] 本轮失败：", err?.message ?? err);
    } finally {
      running = false;
      lastRunAt = new Date(now()).toISOString();
      lastResult = summary;
      saveCursor();
      nextDelayMs = failures > 0
        ? intervalSec * 1000 * Math.min(2 ** failures, MAX_BACKOFF_FACTOR)
        : intervalSec * 1000;
      settleReady(summary);
      runAfterEach(summary);
      if (!stopped) schedule();
    }

    log(
      `[poll] 处理 ${summary.processed} 条、新增 ${summary.inserted} 条、errors ${summary.errors}` +
        (failures > 0 ? `（连续失败 ${failures} 次，下次 ${Math.round(nextDelayMs / 1000)}s 后重试）` : ""),
    );
    if (summary.attachments > 0) log(`[attach] 本轮下载 ${summary.attachments} 个附件`);
    if (summary.images > 0) log(`[image] 本轮下载 ${summary.images} 张图片`);
    return summary;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pollOnce().catch((err) => log("[poll] 未预期的错误：", err?.message ?? err));
    }, nextDelayMs);
    timer.unref?.();
  }

  function status() {
    return {
      enabled,
      running,
      intervalMs: intervalSec * 1000,
      nextDelayMs,
      failures,
      lastRunAt,
      lastResult,
      lastAfterEach,
      maxPerGroup,
      cursorFile,
      groups: Object.entries(cursor.groups).map(([groupId, entry]) => ({
        groupId,
        groupName: entry?.groupName ?? "",
        seq: entry?.seq ?? null,
        updatedAt: entry?.updatedAt ?? null,
      })),
    };
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    // 不等 afterEach：发 abort 信号、撤掉看门狗，避免挂住进程退出。
    if (afterEachWatchdog) {
      clearTimeout(afterEachWatchdog);
      afterEachWatchdog = null;
    }
    if (afterEachController && !afterEachController.signal.aborted) {
      afterEachController.abort(new Error("已中止（stop）"));
      if (lastAfterEach.ok === null) lastAfterEach = { ...lastAfterEach, ok: false, error: "已中止（stop）" };
    }
    settleReady({ enabled, stopped: true });
  }

  if (!enabled) {
    log("[poll] LIVE_POLL_ENABLED 未开启，定时拉取不启动");
    settleReady({ enabled: false });
  } else if (autoStart) {
    // 启动即拉一轮：服务刚起来不该等满一个周期才有数据。
    // 成功路径里 pollOnce 自己会 schedule()；失败时兜底排下一轮，避免异常后彻底停摆。
    pollOnce()
      .catch((err) => log("[poll] 首轮失败：", err?.message ?? err))
      .finally(() => {
        if (!timer && !stopped) schedule();
      });
  }

  return { ready, pollOnce, status, stop, closeClient };
}

/** CLI：`node src/live/poller.js` 常驻（进程内 setTimeout 链 + 指数退避）；`--once` 只跑一轮。 */
async function main() {
  const { loadEnv } = await import("../config.js");
  const { createStore } = await import("../store.js");
  const env = loadEnv(process.cwd());
  const dataDir = resolveDataDir(env);
  const store = createStore({ dataDir });
  const once = process.argv.includes("--once");

  if (once) {
    env.LIVE_POLL_ENABLED = "on"; // 手动触发时不受默认关闭影响
    const poller = startPoller({ env, store });
    const summary = await poller.pollOnce();
    poller.stop();
    poller.closeClient();
    process.exit(summary.errors > 0 ? 1 : 0);
  }

  const poller = startPoller({ env, store });
  const shutdown = () => {
    poller.stop();
    poller.closeClient();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await poller.ready;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[poll] 启动失败：", err?.message ?? err);
    process.exit(1);
  });
}
