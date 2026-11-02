// 图片下载：优先用 OneBot 的 get_image 拿 NapCat 本机路径直接复制（同机部署，省一次 HTTP），
// 拿不到再退回 url 下载。任何失败都返回 { ok:false, reason }，绝不抛：
// 调用方是每 5 分钟一轮的轮询器和实时订阅器，一张图坏了不许把整轮拉取带崩。
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_LABEL_MB = 8;

function fail(reason) {
  return { ok: false, path: null, bytes: 0, reason };
}

/** 只认几种图片后缀：浏览器按后缀给 MIME，拿不到或不在名单里就当 .jpg。 */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function extOf(candidate) {
  const hit = /\.([A-Za-z0-9]{1,8})(?:[?#]|$)/.exec(String(candidate ?? "").trim());
  const ext = hit ? `.${hit[1].toLowerCase()}` : "";
  return IMAGE_EXTS.has(ext) ? ext : ".jpg";
}

/** 落盘键：fileId 优先，其次 file（NapCat 的句柄），最后 url。 */
export function imagePath({ image = {}, dataDir } = {}) {
  const key = String(image.fileId || image.file || image.url || "").trim();
  const digest = createHash("sha1").update(key).digest("hex").slice(0, 16);
  const dir = path.join(String(dataDir ?? process.env.DATA_DIR ?? "./data"), "images");
  const ext = extOf(image.file || image.url || "");
  return { dir, file: path.resolve(dir, `${digest}${ext}`) };
}

function copyLocal(local, { dir, file, maxBytes }) {
  const size = statSync(local).size;
  if (size === 0) return fail("本地图片是空文件");
  if (size > maxBytes) return fail(`图片超过 ${MAX_LABEL_MB}MB，已跳过`);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.part`;
  try {
    copyFileSync(local, tmp);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    return fail(`落盘失败：${err?.message ?? err}`);
  }
  return { ok: true, path: file, bytes: size, reason: null };
}

export async function fetchImage({ callApi, message, dataDir, timeoutMs, fetchImpl } = {}) {
  const image = message?.image;
  if (!image || (!image.file && !image.fileId && !image.url)) return fail("消息里没有图片信息");

  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxBytes = DEFAULT_MAX_BYTES;
  const target = imagePath({ image, dataDir });

  // 幂等：同一张图已经落过盘就不再走网络
  try {
    const size = statSync(target.file).size;
    if (size > 0) return { ok: true, path: target.file, bytes: size, reason: null };
  } catch {
    // 还没有文件是常态
  }

  const tried = [];

  // ① get_image：NapCat 返回本机绝对路径，直接复制最快
  if (image.file) {
    try {
      const res = await callApi("get_image", { file: image.file });
      if (Number(res?.retcode ?? 0) === 0 && res?.status !== "failed") {
        const local = String(res?.data?.file ?? "").trim();
        if (!local) {
          tried.push("get_image 未返回本地路径");
        } else {
          try {
            return copyLocal(local, { dir: target.dir, file: target.file, maxBytes });
          } catch (err) {
            tried.push(`本地图片不可用：${err?.message ?? err}`);
          }
        }
      } else {
        tried.push(`get_image 失败：retcode=${res?.retcode ?? "?"}`);
      }
    } catch (err) {
      tried.push(`get_image 调用失败：${err?.message ?? err}`);
    }
  } else {
    tried.push("消息里没有 file 句柄");
  }

  // ② url 兜底
  const url = String(image.url ?? "").trim();
  if (!url) return fail(`${tried.join("；")}；也没有可下载的 url`);

  let buffer;
  try {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return fail(`下载失败：HTTP ${res.status}`);
    const declared = Number(res.headers?.get?.("content-length") ?? 0);
    if (declared > maxBytes) return fail(`图片超过 ${MAX_LABEL_MB}MB，已跳过`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return fail(`下载超时（${timeout}ms）`);
    }
    return fail(`下载失败：${err?.message ?? err}`);
  }
  if (buffer.byteLength > maxBytes) return fail(`图片超过 ${MAX_LABEL_MB}MB，已跳过`);
  if (buffer.byteLength === 0) return fail("下载内容为空");

  const tmp = `${target.file}.part`;
  try {
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(tmp, buffer);
    renameSync(tmp, target.file);
  } catch (err) {
    rmSync(tmp, { force: true });
    return fail(`落盘失败：${err?.message ?? err}`);
  }
  return { ok: true, path: target.file, bytes: buffer.byteLength, reason: null };
}
