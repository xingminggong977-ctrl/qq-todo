// 自测 8：轮询器的 afterEach 回调（正常 / 抛错 / stop 时挂起），全部用假 request，不联网。
import { mkdtempSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(path.join(tmpdir(), "qq-after-"));
  tmpDirs.push(dir);
  return { dir, store: createStore({ dataDir: dir }) };
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

function rawMsg({ id, gid = 1, gname = "测试群A", text }) {
  return {
    self_id: 10086,
    post_type: "message",
    message_type: "group",
    time: 1793000000 + id,
    message_id: id,
    message_seq: id,
    real_seq: id,
    group_id: gid,
    group_name: gname,
    user_id: 10001,
    sender: { user_id: 10001, nickname: "小D", card: "" },
    message: [{ type: "text", data: { text } }],
  };
}

function createFakeNapcat(groups) {
  return {
    async request(action, params = {}) {
      if (action === "get_group_list") {
        return { status: "ok", retcode: 0, data: groups.map((g) => ({ group_id: g.group_id, group_name: g.group_name })) };
      }
      const group = groups.find((g) => String(g.group_id) === String(params.group_id));
      if (!group || group.messages.length === 0) return { status: "failed", retcode: 1200, message: "消息undefined不存在" };
      const count = Number(params.count ?? 20);
      if (params.message_seq === undefined) return { status: "ok", retcode: 0, data: { messages: group.messages.slice(-count) } };
      const start = group.messages.findIndex((m) => String(m.message_seq) === String(params.message_seq));
      if (start < 0) return { status: "failed", retcode: 1200, message: "消息undefined不存在" };
      return { status: "ok", retcode: 0, data: { messages: group.messages.slice(start, start + count) } };
    },
  };
}

function groupWith(count) {
  return [{ group_id: 1000, group_name: "测试群A", messages: Array.from({ length: count }, (_, i) => rawMsg({ id: i + 1, text: `第${i + 1}条` })) }];
}

// ① afterEach 正常返回
{
  const { dir, store } = freshStore();
  let clock = 1793000000000;
  const seen = [];
  const poller = startPoller({
    env: { LIVE_POLL_ENABLED: "on", LIVE_POLL_INTERVAL_SEC: "30", DATA_DIR: dir },
    store,
    request: createFakeNapcat(groupWith(3)).request,
    log: () => {},
    now: () => (clock += 1000),
    afterEach: async (summary) => {
      seen.push(summary);
    },
  });
  // enabled=on 时构造即自动跑首轮，ready 结算的就是这一轮的 summary
  const first = await poller.ready;
  await waitFor(() => poller.status().lastAfterEach?.ok === true);
  const s1 = poller.status();
  check("① afterEach 被调用 1 次", seen.length === 1, `calls=${seen.length}`);
  check("① 收到的 summary 与 pollOnce 返回一致", JSON.stringify(seen[0]) === JSON.stringify(first), JSON.stringify(seen[0]));
  check("① status().lastAfterEach.ok=true", s1.lastAfterEach?.ok === true && s1.lastAfterEach?.error === null, JSON.stringify(s1.lastAfterEach));
  check("① 下一轮已排期（nextDelayMs=30000）", s1.nextDelayMs === 30000, `nextDelayMs=${s1.nextDelayMs}`);
  const lastRunAt1 = s1.lastRunAt;
  await poller.pollOnce();
  await waitFor(() => seen.length === 2);
  const s2 = poller.status();
  check("① 第二轮 afterEach 仍被调用", seen.length === 2, `calls=${seen.length}`);
  check("① 第二轮 lastRunAt 更新", s2.lastRunAt !== lastRunAt1, `${lastRunAt1} -> ${s2.lastRunAt}`);
  poller.stop();
  check("① failures 未被 afterEach 影响", s2.failures === 0, `failures=${s2.failures}`);
}

// ② afterEach 抛错
{
  const { dir, store } = freshStore();
  const logs = [];
  let calls = 0;
  const poller = startPoller({
    env: { LIVE_POLL_ENABLED: "on", LIVE_POLL_INTERVAL_SEC: "30", DATA_DIR: dir },
    store,
    request: createFakeNapcat(groupWith(2)).request,
    log: (...args) => logs.push(args.join(" ")),
    afterEach: async () => {
      calls += 1;
      throw new Error("boom 回调挂了");
    },
  });
  const first = await poller.ready;
  await waitFor(() => poller.status().lastAfterEach?.ok === false);
  const s1 = poller.status();
  check("② 抛错后 lastAfterEach.ok=false", s1.lastAfterEach?.ok === false, JSON.stringify(s1.lastAfterEach));
  check("② 错误信息被记录", String(s1.lastAfterEach?.error).includes("boom 回调挂了"), s1.lastAfterEach?.error);
  check("② 日志含「afterEach 失败」", logs.some((line) => line.includes("afterEach 失败")), logs.filter((l) => l.includes("afterEach")).join(" | "));
  check("② failures 仍为 0", s1.failures === 0, `failures=${s1.failures}`);
  check("② 下一轮仍被调度（nextDelayMs=30000）", s1.nextDelayMs === 30000, `nextDelayMs=${s1.nextDelayMs}`);
  check("② 本轮入库未受影响", first.inserted === 2, JSON.stringify(first));
  const second = await poller.pollOnce();
  await waitFor(() => calls === 2);
  check("② 下一轮 afterEach 再次被调用", calls === 2 && second.errors === 0, `calls=${calls} errors=${second.errors}`);
  poller.stop();
}

// ③ stop() 期间 afterEach 挂起：不等它、不留定时器
{
  const { dir, store } = freshStore();
  let signals = null;
  const poller = startPoller({
    env: { LIVE_POLL_ENABLED: "on", LIVE_POLL_INTERVAL_SEC: "30", DATA_DIR: dir },
    store,
    request: createFakeNapcat(groupWith(2)).request,
    log: () => {},
    afterEach: (summary, { signal }) => {
      signals = { summary, signal, abortedAt: null };
      signal.addEventListener("abort", () => {
        signals.abortedAt = signal.reason?.message ?? "aborted";
      });
      return new Promise(() => {}); // 永不结算，模拟卡死的提取
    },
  });
  await poller.ready;
  await waitFor(() => signals !== null);
  const t0 = Date.now();
  poller.stop();
  const elapsed = Date.now() - t0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const timers = process.getActiveResourcesInfo().filter((name) => name === "Timeout");
  check("③ stop() 500ms 内返回（不等待挂起回调）", elapsed < 500, `${elapsed}ms`);
  check("③ afterEach 收到 abort 信号", signals?.signal?.aborted === true, JSON.stringify({ aborted: signals?.signal?.aborted, reason: signals?.abortedAt }));
  check("③ status().lastAfterEach 标记已中止", poller.status().lastAfterEach?.error === "已中止（stop）", JSON.stringify(poller.status().lastAfterEach));
  check("③ stop() 后无残留 timer", timers.length === 0, JSON.stringify(timers));
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
