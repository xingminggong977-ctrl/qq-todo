// 消息统一口径：id、类型、时间序列化；B/C/D 都从这里取，避免三处实现漂移。
import { createHash } from "node:crypto";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function asText(value) {
  return value === undefined || value === null ? "" : String(value);
}

// sha1(groupName|ts|sender|text)[0:12]：入参必须由调用方先规范化，否则同一消息会算出不同 id。
export function makeMessageId(groupName, ts, sender, text) {
  const payload = [groupName, ts, sender, text].map(asText).join("|");
  return "m_" + createHash("sha1").update(payload, "utf8").digest("hex").slice(0, 12);
}

const RE_AT_ALL = /@全体成员|@所有人/;
const RE_FILE_MARK = /【文件】/;
const RE_FILE_EXT = /\.(pdf|docx|xlsx|zip|pptx)(?![a-z0-9])/i;
const RE_IMAGE_MARK = /【图片|\[图片\]/;
const RE_REPLY_MARK = /【回复】|回复\s*@/;
const RE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic)(?![a-z0-9])/i;

// 命中多类即 mixed；只命中 text 之外的零类才回落 text。
export function normalizeKind(text, attachment = null) {
  const body = typeof text === "string" ? text : "";
  const name = attachment && typeof attachment === "object" ? asText(attachment.name) : "";
  const hits = [];
  if (RE_AT_ALL.test(body)) hits.push("at_all");
  if (RE_FILE_MARK.test(body) || RE_FILE_EXT.test(body) || RE_FILE_EXT.test(name)) hits.push("file");
  if (RE_IMAGE_MARK.test(body) || RE_IMAGE_EXT.test(name)) hits.push("image");
  if (RE_REPLY_MARK.test(body)) hits.push("reply");
  if (hits.length === 0) return "text";
  return hits.length === 1 ? hits[0] : "mixed";
}

function toMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    // NapCat 的 time 是秒；毫秒（>1e11）也接受
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return toMs(n);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    return null;
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function toBeijingISO(dateOrSeconds) {
  const ms = toMs(dateOrSeconds);
  if (ms === null) return null;
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+08:00`
  );
}

const NOISE_RE = /^(收到|收到了|好的|好嘞|好|嗯+|哦+|ok|okk?|谢谢|谢了|在吗|在不在|哈哈+|hhh+|6+|1+|111|\+|赞|牛|厉害了)[\s，,。.!！~～、…]*$/i;

// 噪声只覆盖「一眼都不用判」的：纯应答、纯表情、纯符号、复读。约饭吐槽留给模型判，避免把判断权藏进正则。
export function looksLikeNoise(text, kind = "text") {
  const body = typeof text === "string" ? text.trim() : "";
  // 图片/文件的正文只是个占位符（「【图片】」），真正内容在图片和附件里，不能按文字判闲聊
  if (kind === "at_all" || kind === "file" || kind === "image") return false;
  if (!body) return true;
  if (NOISE_RE.test(body)) return true;
  if (/^(【图片】|\[图片\]|【表情】|\[表情\])$/.test(body)) return true;
  if (/^[\p{Emoji_Presentation}\p{Emoji}\s\p{P}]+$/u.test(body)) return true;
  if (/^(.)\1{3,}$/.test(body)) return true;
  return false;
}
