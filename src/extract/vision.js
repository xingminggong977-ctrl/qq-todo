// 图片消息视觉识别：把截图里的文字读出来，交给判定管线当正文用。
// 与 attachments.js 同一范式：任何失败都返回 { ok:false, reason }，绝不抛——
// 图片读不出来只是少了一路证据，不该让整条消息判定失败。
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// 单图 4MB：微信群截图像素再大也到不了，超过就是别的东西混进来了
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// 单次输出 1200 字：一张通知截图读出来通常 200-600 字，再多就是模型在发挥
const MAX_OUTPUT_CHARS = 1200;
const DEFAULT_TIMEOUT_MS = 30000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const PROMPT = "把这张图片里的所有文字逐行转录出来，保留数字、时间、地点和文件名。只输出读到的文字，不要解释，不要 markdown 代码块。图片里没有文字就输出空。";
const TIMEOUT = Symbol("vision-timeout");

function fail(reason, model) {
  return { ok: false, text: "", chars: 0, model: model || null, reason };
}

function withTimeout(promise, ms, sentinel) {
  if (!(ms > 0)) return promise;
  let timer = null;
  const guard = new Promise((resolve) => {
    // 故意不 unref：unref 的定时器在事件循环空转时不会触发，等待会变成永挂
    timer = setTimeout(() => resolve(sentinel), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function pickContent(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

export async function describeImage(file, { env = {}, fetchImpl = globalThis.fetch, timeoutMs = 0 } = {}) {
  const settings = env || {};
  const model = String(settings.VISION_MODEL || "qwen3-vl-plus");
  let timer = null;
  try {
    if (String(settings.VISION_ENABLED ?? "on").toLowerCase() === "off") return fail("vision-disabled", model);
    // 只有 OpenAI 兼容的视觉模型能读图；stub 是纯规则判定，别拿它白跑一遍
    if (String(settings.LLM_PROVIDER || "stub").toLowerCase() !== "openai") return fail("provider-not-vision", model);
    const apiKey = String(settings.LLM_API_KEY || "");
    if (!apiKey) return fail("missing-api-key", model);
    if (typeof fetchImpl !== "function") return fail("no-fetch-impl", model);

    const absPath = typeof file === "string" ? file.trim() : "";
    if (!absPath) return fail("文件路径为空", model);
    const ext = path.extname(absPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return fail(`不支持的图片后缀：${ext || "（无）"}`, model);
    let size = 0;
    try {
      size = statSync(absPath).size;
    } catch {
      return fail(`文件不存在：${path.basename(absPath)}`, model);
    }
    if (size > MAX_IMAGE_BYTES) return fail(`图片超过 4MB，已跳过（${size} 字节）`, model);

    const buffer = readFileSync(absPath);
    const base = String(settings.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const ms =
      timeoutMs > 0
        ? timeoutMs
        : Number(settings.VISION_TIMEOUT_MS) > 0
          ? Number(settings.VISION_TIMEOUT_MS)
          : DEFAULT_TIMEOUT_MS;
    const abort = new AbortController();
    // 同样不 unref：超时靠它兜底，事件循环空转时也要能触发
    timer = setTimeout(() => abort.abort(), ms);

    const payload = {
      model,
      temperature: 0,
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:${MIME_BY_EXT[ext]};base64,${buffer.toString("base64")}` } },
          ],
        },
      ],
    };

    let res;
    try {
      res = await withTimeout(
        fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(payload),
          signal: abort.signal,
        }),
        ms + 500,
        TIMEOUT,
      );
    } catch (err) {
      if (err?.name === "AbortError") return fail(`超时（${ms}ms）`, model);
      return fail(`调用失败：${err?.message || err}`, model);
    }
    if (res === TIMEOUT) return fail(`超时（${ms}ms）`, model);
    if (!res || typeof res.ok !== "boolean") return fail("响应无效", model);
    if (!res.ok) return fail(`HTTP ${res.status}`, model);

    let body;
    try {
      body = await withTimeout(res.json(), ms, TIMEOUT);
    } catch (err) {
      return fail(`解析响应失败：${err?.message || err}`, model);
    }
    if (body === TIMEOUT) return fail(`超时（${ms}ms）`, model);

    const raw = pickContent(body).trim();
    if (!raw) return fail("返回内容为空", model);
    const truncated = raw.length > MAX_OUTPUT_CHARS;
    const text = truncated ? `${raw.slice(0, MAX_OUTPUT_CHARS)}…（已截断）` : raw;
    return { ok: true, text, chars: text.length, model, reason: "", truncated };
  } catch (err) {
    return fail(`解析失败：${err?.message || err}`, model);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const VISION_LIMITS = { MAX_IMAGE_BYTES, MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS };
export default describeImage;
