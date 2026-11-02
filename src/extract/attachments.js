// 附件正文抽取：PDF / DOCX / 纯文本，供判定链路把「见附件6」这类消息读懂。
// 约定：永不抛异常——解析失败一律退化成 ok:false + 可读中文 reason，由调用方决定要不要忽略。
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 8000;
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".log"]);
const SUPPORTED_EXTS = new Set([".pdf", ".docx", ...TEXT_EXTS]);
const PAGE_NO_LINE = /^--\s*\d+\s+of\s+\d+\s*--$/i;
const TIMEOUT = Symbol("timeout");

const fail = (kind, reason) => ({ ok: false, kind, text: "", chars: 0, truncated: false, reason });
const extOf = (filename) => path.extname(String(filename ?? "")).toLowerCase();

function numberOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

// \r\n → \n、行首尾去空白、连续空行压成一个、去掉 PDF 抽出的孤立页码行
export function normalizeAttachmentText(input) {
  const lines = String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !PAGE_NO_LINE.test(line));
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    if (!line) {
      blankRun += 1;
      if (blankRun > 1 || out.length === 0) continue;
      out.push("");
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "").trim();
}

async function parsePdf(buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result?.text ?? "";
  } finally {
    try {
      await parser.destroy?.();
    } catch {
      // 释放失败不影响文本结果
    }
  }
}

async function parseDocx(buffer) {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer });
  return value ?? "";
}

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const KIND_LABEL = { pdf: "PDF", docx: "DOCX", text: "文本" };

/**
 * 从内存 buffer 抽文本。永不抛异常。
 * chars = 归一化后、截断前的完整字符数；text 可能已被 maxChars 截断（truncated 为 true）。
 */
export async function extractText(buffer, filename, opts = {}) {
  const maxBytes = numberOr(opts.maxBytes, DEFAULT_MAX_BYTES);
  const maxChars = numberOr(opts.maxChars, DEFAULT_MAX_CHARS);
  const timeoutMs = numberOr(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const ext = extOf(filename);
  if (!SUPPORTED_EXTS.has(ext)) {
    return fail("unsupported", `暂不支持 ${ext || "无后缀文件"}`);
  }
  const size = Buffer.isBuffer(buffer) ? buffer.length : Number(buffer?.byteLength ?? 0);
  if (size > maxBytes) {
    return fail("unsupported", `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已跳过`);
  }
  if (!size) return fail("error", `${KIND_LABEL[ext === ".pdf" ? "pdf" : ext === ".docx" ? "docx" : "text"]} 内容为空`);

  const kind = ext === ".pdf" ? "pdf" : ext === ".docx" ? "docx" : "text";
  let raw;
  try {
    const parsed = TEXT_EXTS.has(ext)
      ? buffer.toString("utf8")
      : kind === "pdf"
        ? parsePdf(buffer)
        : parseDocx(buffer);
    const result = await withTimeout(Promise.resolve(parsed), timeoutMs);
    if (result === TIMEOUT) return fail(kind, "附件解析超时");
    raw = result;
  } catch (err) {
    return fail("error", `${KIND_LABEL[kind]} 解析失败：${err?.message ?? String(err)}`);
  }

  const full = normalizeAttachmentText(raw);
  if (!full) return fail(kind, `${KIND_LABEL[kind]} 未提取到文本`);
  const truncated = full.length > maxChars;
  const text = truncated ? `${full.slice(0, maxChars)}…（已截断）` : full;
  return { ok: true, kind, text, chars: full.length, truncated, reason: null };
}

/** 从磁盘读并抽取；文件不存在 / 读失败 → ok:false + 中文 reason，仍不抛。 */
export async function readAttachmentText(absPath, filename, opts = {}) {
  const target = String(absPath ?? "");
  if (!target) return fail("unsupported", "附件路径为空");
  const maxBytes = numberOr(opts.maxBytes, DEFAULT_MAX_BYTES);
  const name = filename || path.basename(target);
  try {
    const info = await stat(target);
    if (!info.isFile()) return fail("unsupported", "附件不是文件");
    if (info.size > maxBytes) {
      return fail("unsupported", `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已跳过`);
    }
    const buffer = await readFile(target);
    return await extractText(buffer, name, opts);
  } catch (err) {
    if (err?.code === "ENOENT") return fail("error", `附件文件不存在：${path.basename(target)}`);
    return fail("error", `附件读取失败：${err?.message ?? String(err)}`);
  }
}

export default { extractText, readAttachmentText, normalizeAttachmentText };
