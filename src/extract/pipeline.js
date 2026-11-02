// 批量抽取：切分 → 限并发 → 校验归一化 → 幂等入库 → 写 Run。
// 单批失败只记错误，不影响其它批次；失败批次的消息不会入库，下次可重试。
import { toBeijingISO } from "../shared/message.js";
import { createProvider } from "./provider.js";
import { readAttachmentText } from "./attachments.js";
import { describeImage } from "./vision.js";

const MAX_TITLE = 30;
const MAX_CONSTRAINT = 14;
// 附件正文拼进送模型文本时的硬上限：再长也只是噪音，且要控住 token 成本
const MAX_ATTACHMENT_CHARS = 3000;
const ATTACHMENT_MARK = "【附件正文】";
// 图片识别出的文字同理：一张通知截图通常 200-600 字，1200 已足够宽
const MAX_IMAGE_CHARS = 1200;
const IMAGE_MARK = "【图片文字】";

function chunk(list, size) {
  const out = [];
  const step = Math.max(1, Math.floor(Number(size) || 12));
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

async function mapLimit(list, limit, worker) {
  let cursor = 0;
  const size = Math.max(1, Math.min(Math.floor(Number(limit) || 1), list.length || 1));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        await worker(list[index], index);
      }
    }),
  );
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const DROPPED_CAP = 50;

/** 可被 abort 打断的等待：重试间隔不能把 Ctrl+C 拖住。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const wait = Math.max(0, Number(ms) || 0);
    const done = () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, wait);
    if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 校验并归一化模型输出。不信任 provider：id 必须属于本批消息，字段一律再裁一遍。
 * 返回 null 表示这条输出不可用（会被计入 errors）。
 */
export function normalizeClassification(item, batch) {
  const messageId = String(item?.messageId ?? "");
  const message = batch.find((m) => m.id === messageId);
  if (!message) return null;
  const title = String(item?.title ?? "").trim().slice(0, MAX_TITLE);
  const todo = Boolean(item?.todo) && title.length > 0;
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(item?.deadline ?? "")) ? String(item.deadline) : null;
  const constraints = (Array.isArray(item?.constraints) ? item.constraints : [])
    .filter((c) => typeof c === "string" && c.trim())
    .slice(0, 3)
    .map((c) => c.trim().slice(0, MAX_CONSTRAINT));
  return {
    messageId,
    todo,
    title,
    deadline,
    deadlineText: item?.deadlineText ? String(item.deadlineText).trim().slice(0, 20) : null,
    constraints,
    confidence: clampNumber(item?.confidence, 0, 1, 0.5),
    reason: String(item?.reason ?? "").trim().slice(0, 40),
    groupName: message.groupName,
    sender: message.sender,
    ts: message.ts,
  };
}

export async function runExtract({
  env = {},
  store,
  provider = null,
  limit = 0,
  force = false,
  group = null,
  signal = null,
  batchSize = 24,
  concurrency = 3,
  contextBefore = 2,
  maxCalls = 60,
  retryDelayMs = 500,
  // 视觉：visionMax 为 0 时读 env.VISION_MAX_PER_RUN（默认 8）；visionFetch 只为单测注入
  visionMax = 0,
  visionFetch = null,
  visionTimeoutMs = 0,
} = {}) {
  if (!store || typeof store.listMessages !== "function") throw new Error("runExtract 需要 store 实例");
  const t0 = Date.now();
  const startedAt = toBeijingISO(t0);
  const impl = provider || createProvider(env);
  const errors = [];

  const listed = store.listMessages({ limit: limit > 0 ? limit : 0, group: group || "", noise: "exclude" });
  // 同窗口但不过滤 noise：决策日志要能解释「为什么这条没变成待办」，包括入库时就判为闲聊的那批
  const windowed = store.listMessages({ limit: limit > 0 ? limit : 0, group: group || "" }).items;
  const knownTodos = new Map(store.listTodos({ limit: 0 }).items.map((t) => [t.messageId, t.id]));
  const known = new Set(knownTodos.keys());
  // 非 force：只处理还没抽过的消息（幂等，重复跑不新增）
  const candidates = force ? listed.items : listed.items.filter((m) => !known.has(m.id));
  // listed.items 按时间倒序：index 更大 = 更早的消息，正好是「上文」
  const orderIndex = new Map(listed.items.map((m, i) => [m.id, i]));
  // 决策日志：每条输入消息一条，pipeline 只负责产出，落库由 server 侧做
  const decisionModel = impl.kind === "stub" ? "stub" : String(impl.model || impl.name);
  const decisions = new Map();
  const mark = (message, verdict, reason, extra = {}) => {
    if (!message?.id) return;
    decisions.set(message.id, {
      verdict,
      reason: String(reason ?? "").slice(0, 300),
      confidence: Number.isFinite(extra.confidence) ? extra.confidence : null,
      model: extra.model === null ? null : decisionModel,
    });
  };

  const batches = chunk(candidates, batchSize);
  const picked = new Map();
  const dropped = [];
  let processed = 0;
  let costUsd = 0;
  let contextUsed = 0;
  let calls = 0;
  let implicitNegatives = 0;

  function rememberDrop(messages) {
    for (const message of messages) if (!dropped.includes(message.id)) dropped.push(message.id);
  }

  /**
   * 一次模型调用。缺条判定用 messageId 差集（模型可能多给、乱序、重复），不看数组长度。
   * 抛错不往外冒：整批算「未覆盖」，交给上层重试/拆批。
   * parseOk/finishReason 用来区分「没解析出来」（要重试）和「解析成功但模型认定不是待办」（不重试）。
   */
  async function callOnce(batch, label, context) {
    calls += 1;
    let result;
    try {
      result = await impl.classify(batch, { signal, context });
    } catch (err) {
      errors.push(`批次 ${label}（${batch.length} 条）调用失败：${err.message}`);
      for (const message of batch) mark(message, "error", `批次 ${label} 调用失败：${err.message}`);
      return { items: [], pending: batch, parseOk: false, finishReason: null };
    }
    costUsd += Number.isFinite(Number(result?.costUsd)) ? Number(result.costUsd) : 0;
    const parseOk = result?.parseOk !== false;
    const finishReason = typeof result?.finishReason === "string" ? result.finishReason : null;
    const covered = new Set();
    const items = [];
    for (const raw of Array.isArray(result?.items) ? result.items : []) {
      const normalized = normalizeClassification(raw, batch);
      if (!normalized) {
        errors.push(`批次 ${label}：模型返回了不属于本批的 messageId=${raw?.messageId}`);
        continue;
      }
      if (covered.has(normalized.messageId)) continue;
      covered.add(normalized.messageId);
      const source = batch.find((m) => m.id === normalized.messageId);
      mark(
        source,
        normalized.todo ? "todo" : "noise",
        normalized.todo
          ? `判为待办${normalized.reason ? `：${normalized.reason}` : ""}`
          : `模型判定为闲聊${normalized.reason ? `：${normalized.reason}` : ""}`,
        { confidence: normalized.confidence },
      );
      items.push(normalized);
    }
    return { items, pending: batch.filter((m) => !covered.has(m.id)), parseOk, finishReason };
  }

  /**
   * 有界兜底链：直接跑 → 重试一次（retryDelayMs）→ 对半拆批递归 → 单条仍失败记入 dropped。
   * 只有「没解析出来 / 被截断」才值得重试；解析成功却没给 item 是模型判定「不是待办」，
   * 记 implicitNegatives，不重试、不进 dropped。
   * maxCalls 是整轮硬上限：到顶后不再重试，剩余一律 dropped，绝不静默跳过。
   */
  async function resolveBatch(batch, label, context) {
    const collected = [];
    let pending = batch;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!pending.length) return collected;
      if (attempt > 0) {
        await sleep(retryDelayMs, signal);
        if (signal && signal.aborted) {
          rememberDrop(pending);
          for (const message of pending) mark(message, "dropped", "任务被中断，未处理");
          return collected;
        }
      }
      if (calls >= maxCalls) {
        errors.push(`批次 ${label}：达到调用上限 maxCalls=${maxCalls}，剩余 ${pending.length} 条记入 dropped`);
        rememberDrop(pending);
        for (const message of pending) {
          if (decisions.get(message.id)?.verdict === "error") continue;
          mark(message, "dropped", `达到调用上限 maxCalls=${maxCalls}，未处理`);
        }
        return collected;
      }
      const out = await callOnce(pending, label, context);
      for (const item of out.items) {
        processed += 1;
        if (item.todo && !picked.has(item.messageId)) picked.set(item.messageId, item);
      }
      collected.push(...out.items);
      pending = out.pending;
      if (!pending.length) return collected;
      if (out.parseOk && out.finishReason !== "length") {
        implicitNegatives += pending.length;
        for (const message of pending) mark(message, "implicit", "解析成功但模型未给出该条 item，视为非待办");
        return collected;
      }
    }
    if (!pending.length) return collected;
    if (pending.length === 1) {
      errors.push(`消息 ${pending[0].id}（群=${pending[0].groupName}）重试后仍无结果，已丢弃`);
      rememberDrop(pending);
      if (decisions.get(pending[0].id)?.verdict !== "error") {
        mark(pending[0], "dropped", "拆批重试后模型仍未返回该条");
      }
      return collected;
    }
    const mid = Math.ceil(pending.length / 2);
    errors.push(`批次 ${label} 重试后仍缺 ${pending.length} 条，拆成 ${mid}+${pending.length - mid} 继续`);
    const left = await resolveBatch(pending.slice(0, mid), `${label}a`, context);
    const right = await resolveBatch(pending.slice(mid), `${label}b`, context);
    return [...collected, ...left, ...right];
  }

  // 附件正文：同一路径一次 run 内只解析一次；解析失败/不支持就静默按原文判定，
  // 不改 message.text、不改 id、不计 dropped/error——附件失败不算消息失败。
  const attachmentCache = new Map();
  // 图片文字：同一路径同样只识别一次，且整 run 有张数预算（VISION_MAX_PER_RUN），
  // 超预算/识别失败都只是少一路证据，判定照常走原文。
  const imageCache = new Map();
  const visionBudget = visionMax > 0 ? Math.floor(visionMax) : Math.max(0, Math.floor(clampNumber(env?.VISION_MAX_PER_RUN, 0, 64, 0)));
  const visionOn = String(env?.VISION_ENABLED ?? "on").toLowerCase() !== "off";
  let visionAttempts = 0;
  let visionUsed = 0;
  let visionSkipped = 0;
  let visionFailed = 0;
  async function enrichBatch(batch) {
    const out = [];
    for (const message of batch) {
      let text = message.text;
      const file = typeof message.attachmentFile === "string" ? message.attachmentFile : "";
      if (file && message.attachment?.name) {
        try {
          if (!attachmentCache.has(file)) {
            attachmentCache.set(
              file,
              readAttachmentText(file, message.attachment.name, { maxChars: MAX_ATTACHMENT_CHARS }),
            );
          }
          const att = await attachmentCache.get(file);
          if (att?.ok && att.text) text = `${text}\n\n${ATTACHMENT_MARK}\n${att.text.slice(0, MAX_ATTACHMENT_CHARS)}`;
        } catch {
          // 尽力而为：附件读不出来就按原文判定
        }
      }
      const image = typeof message.imageFile === "string" ? message.imageFile : "";
      if (image) {
        // 预算按「发起过的识别次数」算，且在这里同步预占：并发的几个批次不能一起挤进来
        if (!visionOn || (visionBudget > 0 && visionAttempts >= visionBudget)) {
          visionSkipped += 1;
        } else {
          visionAttempts += 1;
          try {
            if (!imageCache.has(image)) {
              imageCache.set(
                image,
                describeImage(image, { env, fetchImpl: visionFetch || undefined, timeoutMs: visionTimeoutMs }),
              );
            }
            const vis = await imageCache.get(image);
            if (vis?.ok && vis.text) {
              text = `${text}\n\n${IMAGE_MARK}\n${vis.text.slice(0, MAX_IMAGE_CHARS)}`;
              visionUsed += 1;
            } else if (vis?.reason === "provider-not-vision" || vis?.reason === "vision-disabled") {
              // 没配视觉模型不是错误，只是这条路走不通
              visionSkipped += 1;
            } else {
              visionFailed += 1;
            }
          } catch {
            visionFailed += 1;
          }
        }
      }
      out.push(text === message.text ? message : { ...message, text });
    }
    return out;
  }

  await mapLimit(batches, concurrency, async (batch, index) => {
    if (signal && signal.aborted) {
      rememberDrop(batch);
      for (const message of batch) mark(message, "dropped", "任务被中断，未处理");
      return;
    }
    const head = orderIndex.get(batch[0]?.id) ?? 0;
    const context = contextBefore > 0
      ? listed.items
          .slice(head + 1, head + 1 + contextBefore * 4)
          .filter((m) => m.groupName === batch[0]?.groupName)
          .slice(0, contextBefore)
          .reverse()
      : [];
    contextUsed += context.length;
    // 只把带附件的批次换成「原文 + 附件正文」的副本送给模型，库里的原文与台账口径都不动
    await resolveBatch(await enrichBatch(batch), String(index + 1), context);
  });

  if (dropped.length) {
    errors.push(`本轮共丢弃 ${dropped.length} 条消息（重试、拆批后仍无结果或达到调用上限），见 droppedMessageIds`);
  }

  // 决策日志：窗口内每条消息一条，保证「每次完整返回」——上游失败也按 error 记，绝不缺条目
  const decisionList = [];
  for (const message of windowed) {
    const base = { messageId: message.id, groupName: message.groupName, at: message.ts, todoId: null };
    if (message.noise) {
      decisionList.push({ ...base, verdict: "noise", reason: "入库时已标记为闲聊，未送模型", model: null, confidence: null });
      continue;
    }
    const hit = decisions.get(message.id);
    if (hit) {
      decisionList.push({ ...base, ...hit, todoId: hit.verdict === "todo" ? knownTodos.get(message.id) ?? null : null });
      continue;
    }
    if (knownTodos.has(message.id)) {
      decisionList.push({
        ...base,
        verdict: "todo",
        reason: "该消息此前已产出待办，本轮幂等跳过",
        model: null,
        confidence: null,
        todoId: knownTodos.get(message.id),
      });
      continue;
    }
    decisionList.push({ ...base, verdict: "dropped", reason: "任务被中断或未进入处理范围", model: null, confidence: null });
  }

  const todos = [...picked.values()].map((item) => ({
    messageId: item.messageId,
    title: item.title,
    deadline: item.deadline,
    deadlineText: item.deadlineText,
    constraints: item.constraints,
    confidence: item.confidence,
    reason: item.reason,
    source: { groupName: item.groupName, sender: item.sender, ts: item.ts },
    model: impl.model || impl.name,
  }));

  const written = todos.length ? await store.addTodos(todos) : { created: 0, updated: 0, skipped: 0 };
  const finishedAt = toBeijingISO(Date.now());
  const run = await store.addRun({
    kind: "extract",
    startedAt,
    finishedAt,
    processed,
    todos: written.created + written.updated,
    errors: errors.length,
    provider: impl.name,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    droppedCount: dropped.length,
    modelCalls: calls,
    visionUsed,
    visionSkipped,
    visionFailed,
  });

  return {
    runId: run.id,
    processed,
    contextUsed,
    todosCreated: written.created,
    todosUpdated: written.updated,
    provider: impl.name,
    durationMs: Date.now() - t0,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    droppedCount: dropped.length,
    droppedMessageIds: dropped.slice(0, DROPPED_CAP),
    implicitNegatives,
    coveredCount: processed,
    modelCalls: calls,
    maxCalls,
    visionUsed,
    visionSkipped,
    visionFailed,
    decisions: decisionList,
    errors,
  };
}

export const runExtraction = runExtract;
export default runExtract;
