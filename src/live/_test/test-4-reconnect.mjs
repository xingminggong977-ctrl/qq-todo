// 自测 4：断线后 5 秒重连，进程不崩。
import { createFakeOneBot, waitFor, watchCrash } from "./fake-onebot.mjs";
import { startLive } from "../napcat.js";

const crashes = watchCrash();
const received = [];
const fake = await createFakeOneBot().listen();
const live = startLive({
  env: { LIVE_ENABLED: "on", NAPCAT_WS_URL: fake.url },
  onMessage: (message) => received.push(message),
});
await waitFor(() => live.status().connected, 3000);

function groupEvent(text) {
  return {
    time: 1793000400,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 9600,
    group_id: 723456789,
    group_name: "示例放行群",
    user_id: 10001,
    sender: { nickname: "罗雨" },
    message: [{ type: "text", data: { text } }],
  };
}

fake.send(groupEvent("断线前"));
await waitFor(() => received.length === 1, 3000);

const beforeCount = fake.state.accepted;
const droppedAt = Date.now();
console.log(`已建立连接，主动掐断假服务器 socket（accepted=${beforeCount}）`);
fake.dropSockets();
await waitFor(() => live.status().connected === false, 2000);
console.log("客户端已感知断线，connected=false");

await waitFor(() => fake.state.accepted > beforeCount, 12000, 50);
const reconnectedAt = Date.now();
const elapsed = reconnectedAt - droppedAt;
await waitFor(() => live.status().connected === true, 3000);
console.log(`重连成功：第 ${fake.state.accepted} 次握手，距断线 ${elapsed} ms`);

fake.send(groupEvent("断线后"));
await waitFor(() => received.length === 2, 3000);
console.log(`重连后仍能收消息，收到 "${received[1]?.text}"，进程 pid=${process.pid} 仍存活`);

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

check("重连发生", fake.state.accepted === beforeCount + 1, `accepted=${fake.state.accepted}`);
check("重连间隔约 5 秒（4500-6500ms）", elapsed >= 4500 && elapsed <= 6500, `${elapsed}ms`);
check("重连后 connected=true", live.status().connected === true);
check("重连后仍能收到消息", received.length === 2, `onMessage 次数=${received.length}`);
check("进程存活", true, `pid=${process.pid}`);
check("无未捕获异常", crashes.length === 0);

live.stop();
await fake.close();
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
