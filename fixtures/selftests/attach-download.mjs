// 自测 10：群文件下载 + attachmentFile 接线。
// 假 OneBot WS（动作通道）+ 假 HTTP 文件源；断言下载、幂等、超限、软失败、解析层字段、轮询集成。
// 用法：node fixtures/selftests/attach-download.mjs
import http from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeOneBot, waitFor } from "../../src/live/_test/fake-onebot.mjs";
import { fetchAttachment } from "../../src/live/attach-fetch.js";
import { buildMessage, startLive } from "../../src/live/napcat.js";
import { createNapcatWsClient, startPoller } from "../../src/live/poller.js";
import { createStore } from "../../src/store.js";

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const tmpDirs = [];
function tmpDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `qq-attach-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

// ---- 假文件源：按 pathname 计次，验证幂等时数它 ----
const FILE_BODY = Buffer.alloc(1024, 0x41);
const hits = new Map();
const fileServer = http.createServer((req, res) => {
  const key = String(req.url);
  hits.set(key, (hits.get(key) ?? 0) + 1);
  if (key.startsWith("/big")) {
    res.writeHead(200, { "content-length": "99999999", "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(0));
    return;
  }
  if (key.startsWith("/deny")) {
    res.writeHead(403);
    res.end("no");
    return;
  }
  res.writeHead(200, { "content-length": String(FILE_BODY.length), "content-type": "application/octet-stream" });
  res.end(FILE_BODY);
});
await new Promise((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
const fileBase = `http://127.0.0.1:${fileServer.address().port}`;

function rawFileMsg({ id, time = 1793000000, gid = 700001, gname = "示例群A", fileId, name, busid = 102 }) {
  return {
    self_id: 10086,
    post_type: "message",
    message_type: "group",
    time,
    message_id: id,
    message_seq: id,
    real_seq: id,
    group_id: gid,
    group_name: gname,
    user_id: 10001,
    sender: { user_id: 10001, nickname: "小D", card: "" },
    message: [{ type: "file", data: { file: name, file_id: fileId, busid, file_size: 1024 } }],
  };
}

// ---- ① 解析层：file 段必须留下 file_id / busid ----
{
  const message = buildMessage(rawFileMsg({ id: 1, fileId: "FID-1", name: "通知.pdf" }), "示例群A");
  check("① parseMessage attachment 带 fileId", message.attachment?.fileId === "FID-1", JSON.stringify(message.attachment));
  check("① parseMessage attachment 带 busid", message.attachment?.busid === 102);
  check("① 文件名与 kind 不变", message.attachment?.name === "通知.pdf" && message.kind === "file", message.text);
}

// ---- ② 正常下载 + 落盘 ----
const dataDir = tmpDir("ok");
{
  const callApi = async (action, params) => {
    check("② 群文件走 get_group_file_url", action === "get_group_file_url", action);
    check("② 参数带 group_id/file_id/busid", params.group_id === 700001 && params.file_id === "FID-DL" && params.busid === 102, JSON.stringify(params));
    return { status: "ok", retcode: 0, data: { url: `${fileBase}/file?id=1` } };
  };
  const first = await fetchAttachment({ callApi, kind: "group", groupId: 700001, fileId: "FID-DL", busid: 102, name: "报表.xlsx", dataDir });
  check("② 下载成功", first.ok === true, JSON.stringify(first));
  check("② 返回绝对路径且落在 DATA_DIR/attachments", first.ok && path.isAbsolute(first.path) && first.path.startsWith(path.join(dataDir, "attachments")), first.path);
  check("② 落盘大小 = 1024", first.ok && statSync(first.path).size === 1024 && first.bytes === 1024, String(first.bytes));
  check("② 后缀沿用 xlsx", first.ok && first.path.endsWith(".xlsx"), path.basename(first.path ?? ""));
  const before = hits.get("/file?id=1");
  const second = await fetchAttachment({ callApi, kind: "group", groupId: 700001, fileId: "FID-DL", busid: 102, name: "报表.xlsx", dataDir });
  check("② 幂等：第二次不再发 HTTP", second.ok === true && hits.get("/file?id=1") === before, `命中 ${before} 次`);
}

// ---- ③ 超限：content-length 超 8MB ----
{
  const dir = tmpDir("big");
  const callApi = async () => ({ status: "ok", retcode: 0, data: { url: `${fileBase}/big?id=2` } });
  const res = await fetchAttachment({ callApi, groupId: 1, fileId: "FID-BIG", name: "大文件.zip", dataDir: dir });
  const left = existsSync(path.join(dir, "attachments"))
    ? readdirSync(path.join(dir, "attachments"), { withFileTypes: true }).filter((e) => e.isFile())
    : [];
  check("③ 超限返回 ok:false", res.ok === false, JSON.stringify(res));
  check("③ reason 报 8MB", res.reason === "文件超过 8MB，已跳过", res.reason);
  check("③ 目录无残留", left.length === 0, `文件数 ${left.length}`);
}

// ---- ④ 软失败：接口报错 / 无 url / HTTP 403 / 没有 file_id ----
{
  const dir = tmpDir("fail");
  const missing = await fetchAttachment({
    callApi: async () => {
      throw new Error("NapCat 不认识 get_group_file_url");
    },
    kind: "group",
    groupId: 1,
    fileId: "FID-MISS",
    name: "a.pdf",
    dataDir: dir,
  });
  check("④ 接口不存在 → ok:false 且不抛", missing.ok === false, JSON.stringify(missing));

  const noUrl = await fetchAttachment({ callApi: async () => ({ status: "ok", retcode: 0, data: {} }), groupId: 1, fileId: "FID-NOURL", name: "a.pdf", dataDir: dir });
  check("④ 未返回 url → reason 明确", noUrl.ok === false && noUrl.reason === "get_group_file_url 未返回 url", noUrl.reason);

  const retcode = await fetchAttachment({ callApi: async () => ({ status: "failed", retcode: 200, message: "no file" }), groupId: 1, fileId: "FID-200", name: "a.pdf", dataDir: dir });
  check("④ retcode 200 → ok:false 且不抛", retcode.ok === false && /retcode=200/.test(retcode.reason ?? ""), retcode.reason);

  const http403 = await fetchAttachment({ callApi: async () => ({ status: "ok", retcode: 0, data: { url: `${fileBase}/deny?id=3` } }), groupId: 1, fileId: "FID-403", name: "a.pdf", dataDir: dir });
  check("④ HTTP 403 → 下载失败：HTTP 403", http403.ok === false && http403.reason === "下载失败：HTTP 403", http403.reason);

  const noId = await fetchAttachment({ callApi: async () => ({ status: "ok", retcode: 0, data: {} }), groupId: 1, fileId: "", name: "a.pdf", dataDir: dir });
  check("④ 缺 file_id → ok:false", noId.ok === false, noId.reason);
}

// ---- ⑤ 私聊走 get_private_file_url ----
{
  const dir = tmpDir("priv");
  const res = await fetchAttachment({
    callApi: async (action, params) => {
      check("⑤ 私聊走 get_private_file_url", action === "get_private_file_url" && params.user_id === 10001 && params.file_id === "FID-P", JSON.stringify(params));
      return { status: "ok", retcode: 0, data: { url: `${fileBase}/file?id=4` } };
    },
    kind: "private",
    userId: 10001,
    fileId: "FID-P",
    name: "私聊.txt",
    dataDir: dir,
  });
  check("⑤ 私聊文件落盘", res.ok === true && statSync(res.path).size === 1024, res.path);
}

// ---- ⑥ 轮询集成：真 WS 动作通道 + 真 HTTP 文件源 ----
async function pollerIntegration() {
  const dir = tmpDir("poll");
  const groupId = 700001;
  const messages = [
    rawFileMsg({ id: 11, fileId: "FID-RUN", name: "群文件.pdf" }),
    {
      ...rawFileMsg({ id: 12, fileId: "FID-RUN", name: "群文件.pdf", time: 1793000060 }),
      message: [{ type: "text", data: { text: "周五交实验报告" } }],
    },
  ];
  const fake = createFakeOneBot({
    requiredToken: "attach-token",
    onAction: (frame) => {
      if (frame.action === "get_group_list") {
        return { status: "ok", retcode: 0, data: [{ group_id: groupId, group_name: "示例群A" }], echo: frame.echo };
      }
      if (frame.action === "get_group_msg_history") {
        return { status: "ok", retcode: 0, data: { messages }, echo: frame.echo };
      }
      if (frame.action === "get_group_file_url") {
        return { status: "ok", retcode: 0, data: { url: `${fileBase}/file?id=run` }, echo: frame.echo };
      }
      return { status: "failed", retcode: 1404, message: "unknown action", echo: frame.echo };
    },
  });
  await fake.listen();

  const store = createStore({ dataDir: dir });
  const logs = [];
  const env = {
    LIVE_POLL_ENABLED: "on",
    NAPCAT_WS_URL: fake.url,
    NAPCAT_ACCESS_TOKEN: "attach-token",
    DATA_DIR: dir,
  };
  const poller = startPoller({ env, store, log: (...args) => logs.push(args.join(" ")), autoStart: false });
  const summary = await poller.pollOnce();
  poller.stop();
  poller.closeClient();

  const listed = store.listMessages({ limit: 50 }).items;
  const fileMsg = listed.find((m) => m.kind === "file");
  check("⑥ 本轮成功、errors 0", summary.errors === 0 && summary.inserted === 2, JSON.stringify(summary));
  check("⑥ 下载计数 1（同一 file_id 只下一次）", summary.attachments === 1, `attachments=${summary.attachments}`);
  check("⑥ 入库的 file 消息带 attachmentFile", typeof fileMsg?.attachmentFile === "string", JSON.stringify(fileMsg?.attachmentFile ?? null));
  const storeKeepsPath = typeof fileMsg?.attachmentFile === "string" && statSync(fileMsg.attachmentFile).size === 1024;
  if (!storeKeepsPath) {
    console.log("NOTE store.normalizeMessage 未保留 attachmentFile，本条只断言到 addMessages 入参（见回报里的契约问题）");
  }
  check("⑥ attachmentFile 指向真实文件（内存层）", fileMsg?.attachmentFile ? statSync(fileMsg.attachmentFile).size === 1024 : false, fileMsg?.attachmentFile ?? "null");
  check("⑥ 群通知消息未被影响", listed.some((m) => m.kind === "text" && m.text === "周五交实验报告"));
  // store 侧必须留住这个键，否则判定链路（pipeline 读 message.attachmentFile）永远拿不到
  const reloaded = createStore({ dataDir: dir }).getMessage(fileMsg?.id ?? "");
  check("⑥ attachmentFile 经 store 落盘后仍在", reloaded?.attachmentFile === fileMsg?.attachmentFile, JSON.stringify(reloaded?.attachmentFile ?? null));
  check("⑥ WS 确实用了 bearer token", fake.state.authHeaders.at(-1) === "Bearer attach-token", String(fake.state.authHeaders.at(-1)));
  check("⑥ 动作序列含 get_group_file_url", fake.state.actions.some((a) => a.action === "get_group_file_url"), fake.state.actions.map((a) => a.action).join(","));

  // 下载必然失败：这一轮仍要成功入库
  const dir2 = tmpDir("poll-fail");
  const store2 = createStore({ dataDir: dir2 });
  const logs2 = [];
  const poller2 = startPoller({
    env: { ...env, DATA_DIR: dir2 },
    store: store2,
    log: (...args) => logs2.push(args.join(" ")),
    autoStart: false,
    fetchAttachmentImpl: async () => {
      throw new Error("get_group_file_url 不存在");
    },
  });
  const summary2 = await poller2.pollOnce();
  poller2.stop();
  poller2.closeClient();
  const listed2 = store2.listMessages({ limit: 50 }).items;
  check("⑥ 下载抛错时本轮仍成功", summary2.errors === 0 && summary2.inserted === 2, JSON.stringify(summary2));
  check("⑥ 下载抛错时不留 attachmentFile", listed2.every((m) => !m.attachmentFile));
  check("⑥ 下载失败有 [attach] skip 日志", logs2.some((line) => line.startsWith("[attach] skip ")), logs2.filter((l) => l.startsWith("[attach]")).join(" | "));
  check("⑥ 日志不含 token", logs2.every((line) => !line.includes("attach-token")));

  await fake.close();
}
await pollerIntegration();

// ---- ⑦ 客户端确实发出 Bearer 头（直连 createNapcatWsClient） ----
{
  const fake = createFakeOneBot({
    requiredToken: "client-token",
    onAction: (frame) => ({ status: "ok", retcode: 0, data: { ok: true }, echo: frame.echo }),
  });
  await fake.listen();
  const client = createNapcatWsClient({ url: fake.url, token: "client-token" });
  const res = await client.request("get_group_list", {});
  check("⑦ 动作通道可用", res?.retcode === 0 && fake.state.authHeaders.at(-1) === "Bearer client-token", String(fake.state.authHeaders.at(-1)));
  client.close();
  await fake.close();
}

// ---- ⑧ live 通道（实时订阅）同样要带上 attachmentFile ----
{
  const dir = tmpDir("live");
  const fake = createFakeOneBot({
    requiredToken: "live-token",
    onAction: (frame) =>
      frame.action === "get_group_file_url"
        ? { status: "ok", retcode: 0, data: { url: `${fileBase}/file?id=live` }, echo: frame.echo }
        : { status: "failed", retcode: 1404, message: "unknown action", echo: frame.echo },
  });
  await fake.listen();
  const got = [];
  const live = startLive({
    env: {
      LIVE_ENABLED: "on",
      NAPCAT_WS_URL: fake.url,
      NAPCAT_ACCESS_TOKEN: "live-token",
      DATA_DIR: dir,
    },
    onMessage: (message) => got.push(message),
  });
  await live.ready;
  fake.send(rawFileMsg({ id: 21, fileId: "FID-LIVE", name: "实时.pdf" }));
  await waitFor(() => got.length > 0, 5000);
  const first = got[0];
  check("⑧ live 通道的文件消息带 attachmentFile", typeof first?.attachmentFile === "string", JSON.stringify(first?.attachmentFile ?? null));
  check("⑧ live 通道落盘文件可读", first?.attachmentFile ? statSync(first.attachmentFile).size === 1024 : false);
  check("⑧ live 通道消息本身字段不变", first?.kind === "file" && first?.text === "【文件】实时.pdf" && first?.source === "napcat", JSON.stringify({ kind: first?.kind, text: first?.text }));
  live.stop();
  await fake.close();
}

// ---- ⑨ live 通道上 NapCat 不认这个 action：消息照收，只是没有 attachmentFile ----
{
  const dir = tmpDir("live-fail");
  const fake = createFakeOneBot({
    requiredToken: "live-token",
    onAction: (frame) => ({ status: "failed", retcode: 1404, message: "不支持的 action", echo: frame.echo }),
  });
  await fake.listen();
  const got = [];
  const live = startLive({
    env: { LIVE_ENABLED: "on", NAPCAT_WS_URL: fake.url, NAPCAT_ACCESS_TOKEN: "live-token", DATA_DIR: dir },
    onMessage: (message) => got.push(message),
  });
  await live.ready;
  fake.send(rawFileMsg({ id: 31, fileId: "FID-NOPE", name: "不支持.pdf" }));
  await waitFor(() => got.length > 0, 5000);
  check("⑨ 接口不支持时消息仍送达", got.length === 1 && got[0].kind === "file", `onMessage 次数=${got.length}`);
  check("⑨ 接口不支持时没有 attachmentFile", !got[0]?.attachmentFile, JSON.stringify(got[0]?.attachmentFile ?? null));
  check("⑨ 订阅器仍连着（未被一次失败打断）", live.status().connected === true, JSON.stringify(live.status()));
  live.stop();
  await fake.close();
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
await new Promise((resolve) => fileServer.close(resolve));
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exitCode = failed ? 1 : 0;
