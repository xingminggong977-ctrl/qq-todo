// 自测 6：私聊转发通道（OWNER_QQ 白名单）+ 群消息行为回归。
import { readFile } from "node:fs/promises";
import { createFakeOneBot, waitFor, watchCrash } from "./fake-onebot.mjs";
import { startLive } from "../napcat.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/private-channel.json", import.meta.url), "utf8"),
);
const events = new Map(fixture.events.map((entry) => [entry.case, entry.payload]));

const crashes = watchCrash();
let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

async function runInstance({ env, cases, expectCount }) {
  const received = [];
  const fake = await createFakeOneBot().listen();
  const live = startLive({
    env: { LIVE_ENABLED: "on", NAPCAT_WS_URL: fake.url, ...env },
    onMessage: (message) => received.push(message),
  });
  await waitFor(() => live.status().connected, 3000);
  for (const name of cases) {
    const payload = events.get(name);
    console.log(`投递 ${name}：${JSON.stringify(payload)}`);
    fake.send(payload);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (expectCount > 0) await waitFor(() => received.length >= expectCount, 3000);
  await new Promise((r) => setTimeout(r, 200));
  const status = live.status();
  live.stop();
  await fake.close();
  return { received, status };
}

// ① owner 私聊 + 陌生 QQ 私聊 + 白名单内群消息 + 白名单外群消息
const base = await runInstance({
  env: { OWNER_QQ: fixture.ownerQq, GROUP_ALLOWLIST: " 示例放行群 , 另一个放行的群 " },
  cases: ["owner-private-text", "stranger-private-text", "group-in-allowlist", "group-outside-allowlist"],
  expectCount: 2,
});

console.log("归一化后的 Message[0]：", JSON.stringify(base.received[0]));
console.log("归一化后的 Message[1]：", JSON.stringify(base.received[1]));

check("① owner 私聊入链 groupName=我转发的通知", base.received[0]?.groupName === "我转发的通知", base.received[0]?.groupName);
check("① owner 私聊 text 正确", base.received[0]?.text === "明天上午九点交报告", base.received[0]?.text);
check("① owner 私聊 kind=text / source=napcat", base.received[0]?.kind === "text" && base.received[0]?.source === "napcat", `${base.received[0]?.kind} / ${base.received[0]?.source}`);
check("① owner 私聊 sender 取 nickname", base.received[0]?.sender === "小D", base.received[0]?.sender);
check("① owner 私聊 ts 走北京时间", base.received[0]?.ts === "2026-10-26T15:35:00+08:00", base.received[0]?.ts);
check("② 陌生 QQ 私聊未触发 onMessage", base.received.length === 2, `onMessage 次数=${base.received.length}`);
check("③ 群消息行为不变（groupName/text/kind）", base.received[1]?.groupName === "示例放行群" && base.received[1]?.text === "@全体成员周五下午交实验报告" && base.received[1]?.kind === "at_all", `${base.received[1]?.groupName} / ${base.received[1]?.text} / ${base.received[1]?.kind}`);
check("③ 白名单外群消息仍被丢弃", !base.received.some((m) => m.groupName === "未放行的群"), JSON.stringify(base.status.groups));
check("status().privateEnabled=true", base.status.privateEnabled === true, JSON.stringify(base.status));

// ② OWNER_QQ 为空 → 私聊通道整体关闭；PRIVATE_ALIAS 可覆盖显示名
const closed = await runInstance({
  env: { OWNER_QQ: "", PRIVATE_ALIAS: "我的备忘" },
  cases: ["owner-private-text"],
  expectCount: 0,
});
check("OWNER_QQ 为空时私聊整体关闭", closed.received.length === 0, `onMessage 次数=${closed.received.length}`);
check("status().privateEnabled=false", closed.status.privateEnabled === false, JSON.stringify(closed.status));

const aliased = await runInstance({
  env: { OWNER_QQ: fixture.ownerQq, PRIVATE_ALIAS: "我的备忘" },
  cases: ["owner-private-text"],
  expectCount: 1,
});
check("PRIVATE_ALIAS 覆盖显示名", aliased.received[0]?.groupName === "我的备忘", aliased.received[0]?.groupName);

// server 的 loadEnv 只透传 DEFAULTS 里声明过的键，OWNER_QQ 不在其中：验证 process.env 兜底生效
process.env.OWNER_QQ = fixture.ownerQq;
const viaProcessEnv = await runInstance({
  env: { GROUP_ALLOWLIST: "" },
  cases: ["owner-private-text"],
  expectCount: 1,
});
delete process.env.OWNER_QQ;
check("env 缺 OWNER_QQ 时走 process.env 兜底", viaProcessEnv.received[0]?.groupName === "我转发的通知", viaProcessEnv.received[0]?.groupName);

check("无未捕获异常", crashes.length === 0);
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
