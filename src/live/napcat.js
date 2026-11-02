// NapCat OneBot 11 只读订阅器：只连、只收、绝不发送任何 QQ 消息或非查询 API。
import * as sharedMessage from "../shared/message.js";
import { resolveDataDir } from "../config.js";
import { fetchAttachment } from "./attach-fetch.js";
import { fetchImage } from "./image-fetch.js";

const { makeMessageId, normalizeKind, toBeijingISO } = sharedMessage;
// looksLikeNoise 不在 §3.1 契约里，做了存在性判断，A 若改名也不至于整条订阅器起不来
const classifyNoise =
  typeof sharedMessage.looksLikeNoise === "function" ? sharedMessage.looksLikeNoise : () => false;

const DEFAULT_WS_URL = "ws://127.0.0.1:3001/";
const RAW_LIMIT = 2000;
const FAST_RETRY_MS = 5000;
const SLOW_RETRY_MS = 60000;
const FAST_RETRY_LIMIT = 20;
const DEDUP_LIMIT = 5000;
const READY_GUARD_MS = 10000;
const ACTION_TIMEOUT_MS = 15000;
// 活性看门狗：NapCat 的 OneBot11 心跳是 30s 一条，半开连接（TCP 活着但不再来数据）
// 只能靠「自己发只读探测 + 看有没有入站帧」发现，光靠 close 事件永远等不到。
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const HEARTBEAT_IDLE_MS = 120000;
const HEARTBEAT_MAX_MISSED = 2;

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const PRIVATE_ALIAS_DEFAULT = "我转发的通知";

export function startLive({ env = {}, onMessage } = {}) {
  const enabled = /^(on|1|true)$/i.test(String(env.LIVE_ENABLED ?? "").trim());
  const wsUrl = String(env.NAPCAT_WS_URL || DEFAULT_WS_URL).trim() || DEFAULT_WS_URL;
  const token = String(env.NAPCAT_ACCESS_TOKEN ?? "").trim();
  const allowlist = String(env.GROUP_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const handle = typeof onMessage === "function" ? onMessage : () => {};

  // 只认自己的 QQ 转发进来，OWNER_QQ 为空时私聊通道整体关闭。
  // 兜底读 process.env：server 的 loadEnv 只透传 DEFAULTS 里声明过的键，OWNER_QQ 不在其中。
  const ownerQq = String(env.OWNER_QQ ?? process.env.OWNER_QQ ?? "").trim();
  const privateEnabled = ownerQq !== "";
  const privateAlias =
    String(env.PRIVATE_ALIAS ?? process.env.PRIVATE_ALIAS ?? "").trim() || PRIVATE_ALIAS_DEFAULT;

  const groups = [];
  const seen = new Set();
  const seenOrder = [];
  let connected = false;
  let lastEventAt = null;
  let attempts = 0;
  let stopped = false;
  let socket = null;
  let retryTimer = null;
  let readySettled = false;
  let resolveReady = () => {};

  // 活性指标：全部只用于 status() 与看门狗，不参与消息链路
  let lastHeartbeatAt = null;
  let lastInboundAt = 0;
  let heartbeatOk = null;
  let heartbeatMissed = 0;
  let heartbeatTimer = null;
  let heartbeatInFlight = false;
  let everConnected = false;
  let reconnects = 0;
  let lastReconnectAt = null;
  // 测试要跑得快，生产用默认 30s/10s/120s；三个值都只在正数时才生效
  const heartbeatIntervalMs = positiveInt(env.LIVE_HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS);
  const heartbeatTimeoutMs = positiveInt(env.LIVE_HEARTBEAT_TIMEOUT_MS, HEARTBEAT_TIMEOUT_MS);
  const heartbeatIdleMs = positiveInt(env.LIVE_HEARTBEAT_IDLE_MS, HEARTBEAT_IDLE_MS);

  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function settleReady() {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  }

  // 不能让 await ready 在 NapCat 不可达时永久挂起
  const readyGuard = setTimeout(settleReady, READY_GUARD_MS);
  readyGuard.unref?.();

  function log(...args) {
    console.log("[live]", ...args);
  }

  // 同一条只读连接上发查询类 action（只用于拿文件下载地址），按 echo 配对响应。
  // 连接未就绪时直接拒绝：文件消息错过下载比拖住整条订阅安全。
  const pendingActions = new Map();
  let actionSeq = 0;
  const dataDir = resolveDataDir(env);

  function rejectActions(reason) {
    for (const [, entry] of pendingActions) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pendingActions.clear();
  }

  function callApi(action, params = {}, timeoutMs = ACTION_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = socket;
      if (!ws || ws.readyState !== 1) {
        reject(new Error("NapCat 未连接"));
        return;
      }
      const echo = `live-${++actionSeq}`;
      const timer = setTimeout(() => {
        pendingActions.delete(echo);
        reject(new Error(`${action} 超时`));
      }, timeoutMs);
      timer.unref?.();
      pendingActions.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        pendingActions.delete(echo);
        reject(new Error(`${action} 发送失败：${err?.message ?? err}`));
      }
    });
  }

  const beijingNow = () => toBeijingISO(Math.floor(Date.now() / 1000));

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatInFlight = false;
  }

  // 半开连接自救：主动关掉走现有重连路径；retryTimer 是幂等闸门，不会重复排期。
  function forceReconnect(reason) {
    if (stopped) return;
    log(`${reason}，强制重连`);
    connected = false;
    const ws = socket;
    if (ws) {
      try {
        ws.close();
      } catch {
        // 关不掉也要重连
      }
    }
    rejectActions("心跳超时，连接已重置");
    if (!retryTimer) scheduleRetry("心跳超时");
  }

  async function heartbeatBeat() {
    if (stopped || !connected || heartbeatInFlight) return;
    const idleMs = Date.now() - lastInboundAt;
    if (idleMs > heartbeatIdleMs) {
      forceReconnect(`心跳超时（${Math.round(idleMs / 1000)}s 无响应）`);
      return;
    }
    heartbeatInFlight = true;
    try {
      await callApi("get_status", {}, heartbeatTimeoutMs);
      heartbeatOk = true;
      heartbeatMissed = 0;
    } catch (err) {
      if (stopped || !connected) return;
      heartbeatMissed += 1;
      heartbeatOk = false;
      log(`心跳无响应（第 ${heartbeatMissed} 次）：${err?.message ?? err}`);
      if (heartbeatMissed >= HEARTBEAT_MAX_MISSED) {
        forceReconnect(`心跳超时（${heartbeatMissed} 次无响应）`);
      }
    } finally {
      heartbeatInFlight = false;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastInboundAt = Date.now();
    heartbeatTimer = setInterval(() => {
      heartbeatBeat().catch((err) => log("心跳检查异常：", err?.message ?? err));
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  // 文件消息：先把文件落到 DATA_DIR/attachments/，再把绝对路径挂到消息上。
  // 失败只记一行日志，消息照原样交给 onMessage（附件拿不到不该丢消息）。
  async function attachFor(message, { kind, groupId, userId }) {
    if (message.kind !== "file") return;
    const fileId = String(message.attachment?.fileId ?? "").trim();
    if (!fileId) return;
    const name = message.attachment?.name ?? "";
    try {
      const outcome = await fetchAttachment({
        callApi,
        kind,
        groupId,
        userId,
        fileId,
        busid: message.attachment?.busid ?? null,
        name,
        dataDir,
        // 实时通道要尽快把消息交出去：下载最多等 10 秒，超时就先按无附件入库
        opts: { timeoutMs: 10000 },
      });
      if (outcome?.ok && outcome.path) message.attachmentFile = outcome.path;
      else log(`[attach] skip ${name || fileId}: ${outcome?.reason ?? "未知原因"}`);
    } catch (err) {
      log(`[attach] skip ${name || fileId}: ${err?.message ?? err}`);
    }
  }

  // 图片消息：落到 DATA_DIR/images/ 后挂 imageFile；失败同样只记日志，消息照常送达。
  async function attachImage(message) {
    if (message.kind !== "image" || !message.image) return;
    try {
      const outcome = await fetchImage({
        callApi,
        message,
        dataDir,
        // 实时通道最坏也就多等 10 秒，和文件下载保持同一口径
        timeoutMs: 10000,
      });
      if (outcome?.ok && outcome.path) message.imageFile = outcome.path;
      else log(`[image] skip ${message.image?.fileId || message.image?.file || "图片"}: ${outcome?.reason ?? "未知原因"}`);
    } catch (err) {
      log(`[image] skip ${message.image?.fileId || "图片"}: ${err?.message ?? err}`);
    }
  }

  function scheduleRetry(reason) {
    if (stopped || retryTimer) return;
    const delay = attempts >= FAST_RETRY_LIMIT ? SLOW_RETRY_MS : FAST_RETRY_MS;
    attempts += 1;
    if (attempts === FAST_RETRY_LIMIT + 1) {
      log(`连续失败 ${FAST_RETRY_LIMIT} 次，改为每 ${SLOW_RETRY_MS / 1000} 秒重试`);
    } else {
      log(`${reason}；${delay / 1000} 秒后重连`);
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    } catch (err) {
      log("WebSocket 构造失败：", err?.message ?? err);
      scheduleRetry("构造失败");
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      connected = true;
      attempts = 0;
      // 第二次之后才算「重连」，用于 /api/live 与线上排查
      if (everConnected) {
        reconnects += 1;
        lastReconnectAt = beijingNow();
      }
      everConnected = true;
      settleReady();
      startHeartbeat();
      log(`已连接 ${wsUrl}`);
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      // 任何入站帧都证明连接还活着（含 action 响应与 meta_event）
      lastInboundAt = Date.now();
      // action 响应帧带 echo，不能当事件消费
      if (parsed?.echo && pendingActions.has(String(parsed.echo))) {
        const entry = pendingActions.get(String(parsed.echo));
        clearTimeout(entry.timer);
        pendingActions.delete(String(parsed.echo));
        entry.resolve(parsed);
        return;
      }
      handleEvent(parsed).catch((err) => log("事件处理失败：", err?.message ?? err));
    });

    ws.addEventListener("error", (event) => {
      const detail =
        (typeof event?.error === "string" ? event.error : event?.error?.message) ||
        event?.message ||
        event?.type ||
        "unknown";
      log("连接错误：", detail);
    });

    ws.addEventListener("close", () => {
      connected = false;
      stopHeartbeat();
      if (socket === ws) socket = null;
      rejectActions("NapCat WS 已断开");
      settleReady();
      if (!stopped) scheduleRetry("连接已关闭");
    });
  }

  async function handleEvent(event) {
    if (!event) return;
    // 心跳/lifecycle 只记活性，绝不进消息链路
    if (event.post_type === "meta_event") {
      lastHeartbeatAt = beijingNow();
      return;
    }
    if (event.post_type !== "message") return;
    const isGroup = event.message_type === "group";
    const isPrivate = event.message_type === "private";
    if (!isGroup && !isPrivate) return;
    // 私聊只收 OWNER_QQ 本人的转发，任何陌生人都写不进库
    if (isPrivate && (!privateEnabled || String(event.user_id ?? "").trim() !== ownerQq)) return;

    const groupName = isGroup
      ? String(event.group_name || event.group_id || "").trim()
      : privateAlias;
    if (!groupName) return;
    // 白名单只约束群消息，私聊别名不参与
    if (isGroup && allowlist.length > 0 && !allowlist.includes(groupName)) return;

    const message = buildMessage(event, groupName);
    if (seen.has(message.id)) return;
    remember(message.id);
    if (!groups.includes(groupName)) groups.push(groupName);
    lastEventAt = toBeijingISO(Math.floor(Date.now() / 1000));

    await attachFor(message, {
      kind: isGroup ? "group" : "private",
      groupId: event.group_id,
      userId: event.user_id,
    });
    await attachImage(message);

    try {
      handle(message);
    } catch (err) {
      // 消费方出错不能连带断掉订阅
      log("onMessage 抛错：", err?.message ?? err);
    }
  }

  function remember(id) {
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > DEDUP_LIMIT) seen.delete(seenOrder.shift());
  }

  function stop() {
    stopped = true;
    clearTimeout(readyGuard);
    stopHeartbeat();
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    connected = false;
    settleReady();
    rejectActions("订阅器已停止");
    if (socket) {
      const closing = socket;
      socket = null;
      try {
        closing.close();
      } catch {
        // 关闭失败不影响退出
      }
    }
  }

  function status() {
    return {
      enabled,
      connected,
      privateEnabled,
      groups: [...groups],
      lastEventAt,
      lastHeartbeatAt,
      reconnects,
      lastReconnectAt,
      heartbeatOk,
    };
  }

  if (!enabled) {
    log("LIVE_ENABLED 未开启，订阅器不连接");
    settleReady();
  } else {
    connect();
  }

  return { ready, status, stop };
}

// 事件 → §3 Message。轮询器复用同一套归一化，两条通道产出的形状不许分叉。
export function buildMessage(event, groupName) {
  const sender = pickSender(event?.sender, event?.user_id);
  const { text, attachment, image } = parseMessage(event?.message);
  const ts = toBeijingISO(event?.time ?? Math.floor(Date.now() / 1000));
  const kind = normalizeKind(text, attachment);
  return {
    id: makeMessageId(groupName, ts, sender, text),
    groupName,
    sender,
    ts,
    kind,
    text,
    attachment,
    // 图片元数据：下游要靠它下载（store 目前只持久化 imageFile，元数据只在内存/实时通道可见）
    image,
    source: "napcat",
    noise: classifyNoise(text, kind),
    raw: rawText(event),
  };
}

function pickSender(sender, userId) {
  if (sender && typeof sender === "object") {
    const card = String(sender.card ?? "").trim();
    if (card) return card;
    const nickname = String(sender.nickname ?? "").trim();
    if (nickname) return nickname;
  }
  return String(userId ?? "").trim();
}

function parseMessage(message) {
  if (typeof message === "string") return { text: message, attachment: null, image: null };

  const parts = [];
  let atAll = false;
  let attachment = null;
  let image = null;

  for (const segment of Array.isArray(message) ? message : []) {
    const type = segment?.type;
    const data = segment?.data ?? {};
    if (type === "text") {
      parts.push(String(data.text ?? ""));
    } else if (type === "at") {
      if (String(data.qq) === "all") atAll = true;
      else parts.push(`@${data.qq ?? ""}`);
    } else if (type === "image") {
      parts.push("【图片】");
      // 多图只留第一张：下载与展示都按「消息里那张图」这一件事做
      if (!image) {
        image = {
          file: String(data.file ?? "").trim(),
          fileId: String(data.file_id ?? "").trim(),
          url: String(data.url ?? "").trim(),
          size: data.file_size ?? data.size ?? null,
        };
      }
    } else if (type === "file") {
      const name = String(data.file || data.name || "");
      parts.push(`【文件】${name}`);
      // file_id 是下载用的句柄（data.file 只是文件名），busid 是群文件分区，两个都要留住
      if (!attachment) {
        attachment = {
          name,
          size: data.file_size ?? null,
          fileId: String(data.file_id ?? "").trim(),
          busid: data.busid ?? null,
        };
      }
    } else {
      parts.push(`[${type ?? "unknown"}]`);
    }
  }

  // 全体成员是角标语义，统一前置
  const text = (atAll ? "@全体成员" : "") + parts.join("");
  return { text, attachment, image };
}

function rawText(event) {
  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch {
    return "";
  }
  if (typeof serialized !== "string") return "";
  return serialized.length > RAW_LIMIT ? serialized.slice(0, RAW_LIMIT) : serialized;
}
