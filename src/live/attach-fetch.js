// 群/私聊文件下载：只做「把文件落到 DATA_DIR/attachments/」这一件事，不解析内容。
// 任何失败都返回 { ok:false, reason }，绝不抛——调用方是每 5 分钟一轮的轮询器，
// 一个下载失败不允许把整轮拉取带崩。
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const ACTION_BY_KIND = { group: "get_group_file_url", private: "get_private_file_url" };

function fail(reason) {
  return { ok: false, path: null, bytes: 0, reason };
}

/** 文件名后缀只留安全字符，取不到就当 .bin。 */
function extOf(name) {
  const hit = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? "").trim());
  return hit ? `.${hit[1].toLowerCase()}` : ".bin";
}

export function attachmentPath({ fileId, name, dataDir }) {
  const digest = createHash("sha1").update(String(fileId)).digest("hex").slice(0, 16);
  const dir = path.join(String(dataDir ?? process.env.DATA_DIR ?? "./data"), "attachments");
  return { dir, file: path.resolve(dir, `${digest}${extOf(name)}`) };
}

export async function fetchAttachment({
  callApi,
  kind = "group",
  groupId,
  userId,
  fileId,
  busid,
  name = "",
  dataDir,
  opts = {},
} = {}) {
  const id = String(fileId ?? "").trim();
  if (!id) return fail("消息里没有 file_id");

  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const action = ACTION_BY_KIND[kind] ?? ACTION_BY_KIND.group;
  const { dir, file } = attachmentPath({ fileId: id, name, dataDir });

  // 幂等：同一个 file_id 已经落过盘就不再走网络
  try {
    const size = statSync(file).size;
    if (size > 0) return { ok: true, path: file, bytes: size, reason: null };
  } catch {
    // 文件还不存在是常态
  }

  const params = kind === "private"
    ? { user_id: userId, file_id: id }
    : { group_id: groupId, file_id: id, busid: busid ?? 0 };

  let url = "";
  try {
    const res = await callApi(action, params);
    if (Number(res?.retcode ?? 0) !== 0 || res?.status === "failed") {
      return fail(`${action} 失败：retcode=${res?.retcode ?? "?"}`);
    }
    url = String(res?.data?.url ?? "").trim();
  } catch (err) {
    // 服务器上的 NapCat 可能根本没有这个 action，接口报错就是这一类
    return fail(`${action} 调用失败：${err?.message ?? err}`);
  }
  if (!url) return fail(`${action} 未返回 url`);

  let buffer;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return fail(`下载失败：HTTP ${res.status}`);
    const declared = Number(res.headers?.get?.("content-length") ?? 0);
    if (declared > maxBytes) return fail(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已跳过`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return fail(`下载超时（${timeoutMs}ms）`);
    return fail(`下载失败：${err?.message ?? err}`);
  }
  if (buffer.byteLength > maxBytes) return fail(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已跳过`);
  if (buffer.byteLength === 0) return fail("下载内容为空");

  const tmp = `${file}.part`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, buffer);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    return fail(`落盘失败：${err?.message ?? err}`);
  }
  return { ok: true, path: file, bytes: buffer.byteLength, reason: null };
}
