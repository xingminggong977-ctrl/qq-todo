// 自测 10：图片消息下载（buildMessage 保留 image 元数据 + fetchImage + poller 预算接线）。
// 全部用假 callApi / 假 fetch，不走网络、不碰真 NapCat。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../store.js";
import { buildMessage } from "../napcat.js";
import { fetchImage } from "../image-fetch.js";
import { startPoller } from "../poller.js";

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const tmpDirs = [];
function tmpDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `qq-image-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

const IMAGE_BYTES = Buffer.from("fake-image-bytes-0123456789");

function rawImageMsg({ id, file, fileId, url, time = 1793000000, gid = 900001, gname = "图片测试群" }) {
  const data = { file };
  if (fileId) data.file_id = fileId;
  if (url) data.url = url;
  return {
    self_id: 10086,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    time,
    message_id: id,
    message_seq: id,
    real_seq: id,
    group_id: gid,
    group_name: gname,
    user_id: 10001,
    sender: { user_id: 10001, nickname: "小明", card: "" },
    message: [{ type: "image", data }],
  };
}

function okFetch(bytes = IMAGE_BYTES) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(bytes.length) : null) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  });
}

// ---- ① buildMessage 保留图片元数据（多图只留第一张） ----
{
  const message = buildMessage(
    {
      post_type: "message",
      message_type: "group",
      group_id: 900001,
      group_name: "图片测试群",
      message_id: 1,
      user_id: 10001,
      time: 1793000000,
      sender: { user_id: 10001, nickname: "小明" },
      message: [
        { type: "image", data: { file: "a.jpg", file_id: "FID-A", url: "https://example.test/a.jpg", file_size: 1234 } },
        { type: "image", data: { file: "b.jpg", file_id: "FID-B", url: "https://example.test/b.jpg" } },
      ],
    },
    "图片测试群",
  );
  check("① text 仍是【图片】并只出现两次", message.text === "【图片】【图片】", message.text);
  check("① kind=image", message.kind === "image", message.kind);
  check(
    "① 保留第一个 image 的 file/fileId/url/size",
    message.image?.file === "a.jpg" &&
      message.image?.fileId === "FID-A" &&
      message.image?.url === "https://example.test/a.jpg" &&
      message.image?.size === 1234,
    JSON.stringify(message.image),
  );
}

// ---- ② get_image 成功：复制本地文件，落 <DATA_DIR>/images/ ----
{
  const dir = tmpDir("copy");
  const local = path.join(dir, "napcat-local.jpg");
  writeFileSync(local, IMAGE_BYTES);
  let calls = 0;
  const message = buildMessage(rawImageMsg({ id: 11, file: "abc.image", fileId: "FID-OK" }), "图片测试群");
  const outcome = await fetchImage({
    callApi: async (action, params) => {
      calls += 1;
      check("② 优先调用 get_image 且参数是 {file}", action === "get_image" && params.file === "abc.image", JSON.stringify({ action, params }));
      return { status: "ok", retcode: 0, data: { file: local } };
    },
    message,
    dataDir: dir,
  });
  check("② get_image 成功", outcome.ok === true, JSON.stringify(outcome.reason));
  check("② 落到 DATA_DIR/images 下", String(outcome.path).includes(`${path.sep}images${path.sep}`) && existsSync(outcome.path), outcome.path);
  check("② 内容一致", readFileSync(outcome.path).equals(IMAGE_BYTES), `${readFileSync(outcome.path).length}B`);
  check("② 只调一次 get_image", calls === 1, `calls=${calls}`);
}

// ---- ③ get_image 失败 → 退回 url 下载；④ 同 id 幂等不再走网络 ----
{
  const dir = tmpDir("fallback");
  const message = buildMessage(
    rawImageMsg({ id: 12, file: "abc.image", fileId: "FID-FALLBACK", url: "https://example.test/pic.jpg" }),
    "图片测试群",
  );
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return okFetch()();
  };
  const first = await fetchImage({
    callApi: async () => ({ status: "failed", retcode: 1404, message: "不支持的 action" }),
    message,
    dataDir: dir,
    fetchImpl,
  });
  check("③ get_image 报错时退回 url 下载", first.ok === true, JSON.stringify(first.reason));
  check("③ 下载内容落盘一致", readFileSync(first.path).equals(IMAGE_BYTES), `${readFileSync(first.path).length}B`);

  const callsBefore = fetches;
  const second = await fetchImage({
    callApi: async () => {
      throw new Error("不该再调 get_image");
    },
    message,
    dataDir: dir,
    fetchImpl,
  });
  check("④ 同 fileId 幂等：路径不变", second.ok === true && second.path === first.path, second.path);
  check("④ 幂等时没有重复下载", fetches === callsBefore, `fetches=${fetches}`);
}

// ---- ⑤ 两个通道都超时：不抛，返回中文 reason ----
{
  const dir = tmpDir("timeout");
  const message = buildMessage(
    rawImageMsg({ id: 13, file: "slow.image", fileId: "FID-SLOW", url: "https://example.test/slow.jpg" }),
    "图片测试群",
  );
  const outcome = await fetchImage({
    callApi: async () => {
      throw new Error("get_image 超时");
    },
    message,
    dataDir: dir,
    timeoutMs: 50,
    fetchImpl: async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    },
  });
  check("⑤ 超时返回 ok:false 且不抛", outcome.ok === false && outcome.path === null, JSON.stringify(outcome.reason));
  check("⑤ reason 说明是下载超时", String(outcome.reason).includes("下载超时（50ms）"), outcome.reason);
}

// ---- ⑥ get_image 指到不存在的本地文件且没有 url：不抛，reason 可读 ----
{
  const dir = tmpDir("missing");
  const message = buildMessage(
    rawImageMsg({ id: 14, file: "gone.image", fileId: "FID-GONE" }),
    "图片测试群",
  );
  const outcome = await fetchImage({
    callApi: async () => ({ status: "ok", retcode: 0, data: { file: path.join(dir, "not-there.jpg") } }),
    message,
    dataDir: dir,
  });
  check("⑥ 本地文件不存在时返回 ok:false", outcome.ok === false, JSON.stringify(outcome.reason));
  check("⑥ reason 同时说明本地不可用与没有 url", String(outcome.reason).includes("本地图片不可用") && String(outcome.reason).includes("没有可下载的 url"), outcome.reason);
}

// ---- ⑦ poller 接线：imageFile 挂上、result.images 计数、单轮上限 8 张 ----
{
  const dir = tmpDir("poll");
  const raws = Array.from({ length: 10 }, (_, i) =>
    rawImageMsg({ id: 100 + i, file: `p${i}.image`, fileId: `FID-P${i}`, time: 1793000100 + i }),
  );
  const request = async (action) => {
    if (action === "get_group_list") return { status: "ok", retcode: 0, data: [{ group_id: 900001, group_name: "图片测试群" }] };
    if (action === "get_group_msg_history") return { status: "ok", retcode: 0, data: { messages: raws } };
    return { status: "ok", retcode: 0, data: {} };
  };
  const store = createStore({ dataDir: dir });
  const handed = [];
  const realAdd = store.addMessages.bind(store);
  store.addMessages = async (messages) => {
    handed.push(...messages);
    return realAdd(messages);
  };
  const downloaded = [];
  const fetchImageImpl = async ({ message, dataDir }) => {
    downloaded.push(message.image.fileId);
    return { ok: true, path: path.join(dataDir, "images", `${message.image.fileId}.jpg`), bytes: 10, reason: null };
  };
  const poller = startPoller({
    env: { LIVE_POLL_ENABLED: "on", DATA_DIR: dir, LIVE_POLL_MAX_PER_GROUP: "50" },
    store,
    request,
    log: () => {},
    autoStart: false,
    fetchImageImpl,
  });
  // autoStart:false 时 ready 不会自己结算（那是给测试的确定性开关），直接手动跑一轮
  const summary = await poller.pollOnce();
  const withImage = handed.filter((m) => typeof m.imageFile === "string").length;
  check("⑦ 一轮入库 10 条", summary.inserted === 10, JSON.stringify(summary));
  check("⑦ result.images 计入 8 张（单轮上限）", summary.images === 8, `images=${summary.images}`);
  check("⑦ 恰好 8 条消息带上 imageFile", withImage === 8, `带图的=${withImage}`);
  check("⑦ 实际只下载 8 次", downloaded.length === 8, `downloaded=${downloaded.length}`);
  check("⑦ 轮询没有因为图片失败而报错", summary.errors === 0, `errors=${summary.errors}`);
  poller.stop();
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exitCode = failed ? 1 : 0;
