// 自测 11：NapCat WS 活性看门狗与连接指标。
// 假 OneBot WS：一组正常回 get_status，一组故意不回；再验 meta_event 只记活性不进消息链路。
// 用法：node fixtures/selftests/live-heartbeat.mjs
import { createFakeOneBot, waitFor, watchCrash } from "../../src/live/_test/fake-onebot.mjs";
import { startLive } from "../../src/live/napcat.js";

let failed = false;
const realLog = console.log;
const logs = [];
function check(label, ok, detail) {
  realLog(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const crashes = watchCrash();
// 只收订阅器自己的日志，断言输出仍然直出
function captureLogs() {
  console.log = (...args) => {
    const line = args.join(" ");
    if (line.startsWith("[live]")) {
      logs.push(line);
      return;
    }
    realLog(...args);
  };
}
function releaseLogs() {
  console.log = realLog;
}

function envFor(url, extra = {}) {
  return {
    LIVE_ENABLED: "on",
    NAPCAT_WS_URL: url,
    NAPCAT_ACCESS_TOKEN: "hb-token",
    ...extra,
  };
}

function groupMessage({ id, text, groupId = 900001, groupName = "心跳测试群" }) {
  return {
    post_type: "message",
    message_type: "group",
    group_id: groupId,
    group_name: groupName,
    message_id: id,
    user_id: 10001,
    time: 1793000000,
    self_id: 10086,
    sender: { user_id: 10001, nickname: "小明", card: "" },
    message: [{ type: "text", data: { text } }],
    raw_message: text,
  };
}

const statusKeys = [
  "enabled",
  "connected",
  "privateEnabled",
  "groups",
  "lastEventAt",
  "lastHeartbeatAt",
  "reconnects",
  "lastReconnectAt",
  "heartbeatOk",
];

// ---- ① 服务端正常回 get_status：heartbeatOk 变 true，reconnects 不增长 ----
{
  const fake = createFakeOneBot({
    requiredToken: "hb-token",
    onAction: (frame) =>
      frame?.action === "get_status"
        ? { status: "ok", retcode: 0, data: { online: true, good: true }, echo: frame.echo }
        : null,
  });
  await fake.listen();
  captureLogs();
  const got = [];
  const live = startLive({
    env: envFor(fake.url, {
      LIVE_HEARTBEAT_INTERVAL_MS: "300",
      LIVE_HEARTBEAT_TIMEOUT_MS: "200",
      LIVE_HEARTBEAT_IDLE_MS: "120000",
    }),
    onMessage: (message) => got.push(message),
  });
  await live.ready;
  let heartbeatSeen = true;
  try {
    await waitFor(() => live.status().heartbeatOk === true, 5000);
  } catch {
    heartbeatSeen = false;
  }
  const status = live.status();
  check("① 正常心跳时 heartbeatOk===true", heartbeatSeen && status.heartbeatOk === true, JSON.stringify(status.heartbeatOk));
  check("① reconnects 不增长", status.reconnects === 0, `reconnects=${status.reconnects}`);
  check(
    "① 确实发出了 get_status 只读查询帧",
    fake.state.actions.some((item) => item.action === "get_status"),
    `actions=${JSON.stringify(fake.state.actions.map((item) => item.action))}`,
  );
  check("① 连接保持", status.connected === true, `connected=${status.connected}`);
  live.stop();
  await fake.close();
  releaseLogs();
}

// ---- ② 服务端不回 get_status：12 秒内强制重连，reconnects +1；③ 重连后仍能收消息 ----
{
  const fake = createFakeOneBot({ requiredToken: "hb-token", onAction: () => null });
  await fake.listen();
  captureLogs();
  const startedAt = Date.now();
  const got = [];
  const live = startLive({
    env: envFor(fake.url, {
      LIVE_HEARTBEAT_INTERVAL_MS: "300",
      LIVE_HEARTBEAT_TIMEOUT_MS: "200",
      LIVE_HEARTBEAT_IDLE_MS: "120000",
    }),
    onMessage: (message) => got.push(message),
  });
  await live.ready;
  let forced = true;
  try {
    await waitFor(() => logs.some((line) => line.includes("心跳超时") && line.includes("强制重连")), 12000);
  } catch {
    forced = false;
  }
  const forcedInMs = Date.now() - startedAt;
  const forcedLine = logs.find((line) => line.includes("心跳超时") && line.includes("强制重连")) ?? "";
  check("② 12 秒内出现强制重连日志", forced && forcedInMs <= 12000, `${forcedInMs}ms | ${forcedLine}`);
  let reconnected = true;
  try {
    await waitFor(() => live.status().reconnects >= 1, 12000);
  } catch {
    reconnected = false;
  }
  const status = live.status();
  check("② reconnects +1", reconnected && status.reconnects === 1, `reconnects=${status.reconnects}`);
  check("② lastReconnectAt 有值", Boolean(status.lastReconnectAt), JSON.stringify(status.lastReconnectAt));
  fake.send(groupMessage({ id: 51, text: "重连后的第一条" }));
  let delivered = true;
  try {
    await waitFor(() => got.length === 1, 8000);
  } catch {
    delivered = false;
  }
  check("③ 重连后仍能正常收消息", delivered && got[0]?.text === "重连后的第一条", `onMessage 次数=${got.length}`);
  live.stop();
  await fake.close();
  releaseLogs();
}

// ---- ④ meta_event 只记活性，不影响消息链路；status() 保留原有字段 ----
{
  const fake = createFakeOneBot({
    requiredToken: "hb-token",
    onAction: (frame) =>
      frame?.action === "get_status" ? { status: "ok", retcode: 0, data: {}, echo: frame.echo } : null,
  });
  await fake.listen();
  captureLogs();
  const got = [];
  const live = startLive({
    env: envFor(fake.url, {
      LIVE_HEARTBEAT_INTERVAL_MS: "60000",
      LIVE_HEARTBEAT_TIMEOUT_MS: "5000",
      LIVE_HEARTBEAT_IDLE_MS: "120000",
    }),
    onMessage: (message) => got.push(message),
  });
  await live.ready;
  fake.send({
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    time: 1793000100,
    self_id: 10086,
    status: { online: true, good: true },
    interval: 30000,
  });
  fake.send({
    post_type: "meta_event",
    meta_event_type: "lifecycle",
    sub_type: "connect",
    time: 1793000101,
    self_id: 10086,
  });
  let beatSeen = true;
  try {
    await waitFor(() => live.status().lastHeartbeatAt !== null, 4000);
  } catch {
    beatSeen = false;
  }
  check("④ meta_event 计入 lastHeartbeatAt", beatSeen, JSON.stringify(live.status().lastHeartbeatAt));
  check("④ meta_event 不触发 onMessage", got.length === 0, `onMessage 次数=${got.length}`);
  fake.send(groupMessage({ id: 71, text: "心跳之后的正常消息" }));
  let delivered = true;
  try {
    await waitFor(() => got.length === 1, 5000);
  } catch {
    delivered = false;
  }
  check(
    "④ meta_event 不影响消息计数",
    delivered && got.length === 1 && got[0]?.text === "心跳之后的正常消息",
    `onMessage 次数=${got.length}`,
  );
  const status = live.status();
  const missing = statusKeys.filter((key) => !(key in status));
  check("④ status() 保留原有字段并新增四个指标", missing.length === 0, JSON.stringify(Object.keys(status)));
  check("④ 未开播 heartbeatOk 允许为 null", status.heartbeatOk === null, JSON.stringify(status.heartbeatOk));
  live.stop();
  await fake.close();
  releaseLogs();
}

check("全程无未捕获异常", crashes.length === 0, crashes.length === 0 ? "无" : crashes[0]);
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exitCode = failed ? 1 : 0;
