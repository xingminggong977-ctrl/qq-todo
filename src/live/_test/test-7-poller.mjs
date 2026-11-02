// 自测 7：定时增量拉取器（伪造 OneBot 动作通道，不起网络、不碰真 NapCat）。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../store.js";
import { startPoller } from "../poller.js";

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const tmpDirs = [];
function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "qq-poll-"));
  tmpDirs.push(dir);
  return { dir, store: createStore({ dataDir: dir }) };
}

function rawMsg({ id, time, text, gid, gname, user = 10001, nick = "小D" }) {
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
    user_id: user,
    sender: { user_id: user, nickname: nick, card: "" },
    message: [{ type: "text", data: { text } }],
  };
}

/** 假 NapCat：message_seq 是「从该条开始（含）向后」的游标，省略则取最新一页。 */
function createFakeNapcat({ groups }) {
  const calls = [];
  const retcodes = new Map();
  const failNext = { list: 0 };
  return {
    calls,
    retcodes,
    failNext,
    async request(action, params = {}) {
      calls.push({ action, params });
      if (action === "get_group_list") {
        if (failNext.list > 0) {
          failNext.list -= 1;
          throw new Error("get_group_list 连接被拒");
        }
        return { status: "ok", retcode: 0, data: groups.map((g) => ({ group_id: g.group_id, group_name: g.group_name })) };
      }
      const group = groups.find((g) => String(g.group_id) === String(params.group_id));
      if (!group) return { status: "failed", retcode: 100, message: "no group" };
      const forced = retcodes.get(String(params.group_id));
      if (forced) return { status: "failed", retcode: forced, message: "消息undefined不存在" };
      if (group.messages.length === 0) {
        return { status: "failed", retcode: 1200, message: "消息undefined不存在" };
      }
      const count = Number(params.count ?? 20);
      if (params.message_seq === undefined) {
        return { status: "ok", retcode: 0, data: { messages: group.messages.slice(-count) } };
      }
      const start = group.messages.findIndex((m) => String(m.message_seq) === String(params.message_seq));
      if (start < 0) return { status: "failed", retcode: 1200, message: `消息${params.message_seq}不存在` };
      return { status: "ok", retcode: 0, data: { messages: group.messages.slice(start, start + count) } };
    },
  };
}

function collectLogs() {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.map((a) => String(a)).join(" ")) };
}

// ① 两页历史：首轮建档入库，次轮只补新增，第三轮不重复入库
{
  const { dir, store } = freshStore();
  const group = {
    group_id: 1000,
    group_name: "测试群A",
    messages: [1, 2, 3].map((i) => rawMsg({ id: i, time: 1793000000 + i, text: `第${i}条`, gid: 1000, gname: "测试群A" })),
  };
  const fake = createFakeNapcat({ groups: [group] });
  const poller = startPoller({
    autoStart: false,
    env: { LIVE_POLL_ENABLED: "on", LIVE_POLL_INTERVAL_SEC: "300", DATA_DIR: dir },
    store,
    request: fake.request,
    log: () => {},
  });

  const first = await poller.pollOnce();
  poller.stop();
  const cursorFile = path.join(dir, "live-poll.json");
  const cursor1 = JSON.parse(readFileSync(cursorFile, "utf8"));
  check("① 首轮建档入库 3 条", first.processed === 3 && first.inserted === 3, JSON.stringify(first));
  check("① 首轮游标指向最新一条", String(cursor1.groups["1000"].seq) === "3", JSON.stringify(cursor1.groups["1000"]));
  check("① 首轮不带 message_seq", fake.calls.some((c) => c.action === "get_group_msg_history" && c.params.message_seq === undefined), JSON.stringify(fake.calls.map((c) => c.params)));

  group.messages.push(
    rawMsg({ id: 4, time: 1793000004, text: "第4条", gid: 1000, gname: "测试群A" }),
    rawMsg({ id: 5, time: 1793000005, text: "第5条", gid: 1000, gname: "测试群A" }),
  );
  const second = await poller.pollOnce();
  poller.stop();
  const cursor2 = JSON.parse(readFileSync(cursorFile, "utf8"));
  check("② 次轮只补 2 条新增", second.processed === 3 && second.inserted === 2, JSON.stringify(second));
  check("② 次轮带游标请求", fake.calls.some((c) => String(c.params.message_seq) === "3"), JSON.stringify(fake.calls.map((c) => c.params)));
  check("② 游标前进到 5", String(cursor2.groups["1000"].seq) === "5", JSON.stringify(cursor2.groups["1000"]));

  const third = await poller.pollOnce();
  poller.stop();
  const stored = await store.counts();
  check("③ 重复轮次不重入", third.inserted === 0 && stored.messages === 5, `inserted=${third.inserted} stored=${stored.messages}`);
}

// ② 单群单次上限 LIVE_POLL_MAX_PER_GROUP
{
  const { dir, store } = freshStore();
  const many = Array.from({ length: 120 }, (_, i) => rawMsg({ id: 10000 + i, time: 1793000000 + i, text: `批量${i}`, gid: 2000, gname: "大群" }));
  const fake = createFakeNapcat({ groups: [{ group_id: 2000, group_name: "大群", messages: many }] });
  const poller = startPoller({ autoStart: false, env: { LIVE_POLL_ENABLED: "on", LIVE_POLL_MAX_PER_GROUP: "50", DATA_DIR: dir }, store, request: fake.request, log: () => {} });
  const summary = await poller.pollOnce();
  poller.stop();
  check("④ 单群单次上限 50 条", summary.inserted === 50, JSON.stringify(summary));
}

// ③ 空群 retcode 1200 不算失败；错误群只影响自己
{
  const { dir, store } = freshStore();
  const okGroup = { group_id: 3000, group_name: "正常群", messages: [rawMsg({ id: 1, time: 1793000001, text: "正常群消息", gid: 3000 })] };
  const emptyGroup = { group_id: 3001, group_name: "空群", messages: [] };
  const badGroup = { group_id: 3002, group_name: "报错群", messages: [rawMsg({ id: 2, time: 1793000002, text: "x", gid: 3002 })] };
  const { lines, log } = collectLogs();
  const fake = createFakeNapcat({ groups: [okGroup, emptyGroup, badGroup] });
  fake.retcodes.set("3002", 500);
  const poller = startPoller({
    autoStart: false,
    env: { LIVE_POLL_ENABLED: "on", NAPCAT_ACCESS_TOKEN: "secret-token-xyz", DATA_DIR: dir },
    store,
    request: fake.request,
    log,
  });
  const summary = await poller.pollOnce();
  poller.stop();
  check("⑤ 空群不计错误", summary.errors === 1, JSON.stringify(summary));
  check("⑤ 正常群仍然入库", (await store.counts()).messages === 1, JSON.stringify(await store.counts()));
  const joined = lines.join("\n");
  check("⑤ 日志不含 token", !joined.includes("secret-token-xyz"));
  check("⑤ 日志不含消息原文", !joined.includes("正常群消息"));
}

// ④ 失败指数退避
{
  const { dir, store } = freshStore();
  const fake = createFakeNapcat({ groups: [{ group_id: 1, group_name: "g", messages: [] }] });
  fake.failNext.list = 3;
  const poller = startPoller({ autoStart: false, env: { LIVE_POLL_ENABLED: "on", LIVE_POLL_INTERVAL_SEC: "300", DATA_DIR: dir }, store, request: fake.request, log: () => {} });
  const r1 = await poller.pollOnce();
  const s1 = poller.status();
  const r2 = await poller.pollOnce();
  const s2 = poller.status();
  const r3 = await poller.pollOnce();
  const s3 = poller.status();
  const r4 = await poller.pollOnce();
  const s4 = poller.status();
  poller.stop();
  check("⑥ 连续失败计数 1→2→3", s1.failures === 1 && s2.failures === 2 && s3.failures === 3, `${s1.failures}/${s2.failures}/${s3.failures}`);
  check("⑥ 退避 2x/4x/8x 封顶", s1.nextDelayMs === 600000 && s2.nextDelayMs === 1200000 && s3.nextDelayMs === 2400000, `${s1.nextDelayMs}/${s2.nextDelayMs}/${s3.nextDelayMs}`);
  check("⑥ 恢复后清零并回正间隔", s4.failures === 0 && s4.nextDelayMs === 300000, `${s4.failures}/${s4.nextDelayMs}`);
  check("⑥ 失败轮次 errors 计数", r1.errors === 1 && r2.errors === 1 && r4.errors === 0, `${r1.errors}/${r2.errors}/${r3.errors}/${r4.errors}`);
}

// ⑤ 默认关闭：不建连、不发请求
{
  const { dir, store } = freshStore();
  let called = 0;
  const poller = startPoller({ autoStart: false, env: { DATA_DIR: dir }, store, request: async () => { called += 1; return { retcode: 0, data: [] }; }, log: () => {} });
  const summary = await poller.pollOnce();
  poller.stop();
  check("⑦ 默认关闭时不发任何请求", summary.enabled === false && called === 0, JSON.stringify(summary));
  check("⑦ status().enabled=false", poller.status().enabled === false, JSON.stringify(poller.status()));
}

for (const dir of tmpDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响结论
  }
}

console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);


