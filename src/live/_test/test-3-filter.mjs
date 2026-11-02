// 自测 3：private 消息与 notice 事件必须被忽略。
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

const privateEvent = {
  time: 1793000100,
  self_id: 10086,
  post_type: "message",
  message_type: "private",
  sub_type: "friend",
  message_id: 9520,
  user_id: 20002,
  sender: { user_id: 20002, nickname: "陌生人" },
  message: [{ type: "text", data: { text: "私聊消息：帮我带个饭" } }],
};

const noticeEvent = {
  time: 1793000200,
  self_id: 10086,
  post_type: "notice",
  notice_type: "group_increase",
  group_id: 723456789,
  operator_id: 0,
  user_id: 30003,
};

const groupEvent = {
  time: 1793000300,
  self_id: 10086,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: 9521,
  group_id: 723456789,
  group_name: "示例放行群",
  user_id: 10001,
  sender: { user_id: 10001, nickname: "罗雨", card: "罗雨" },
  message: [{ type: "text", data: { text: "对照组：这条应该被收下" } }],
};

console.log("投递 private 事件：", JSON.stringify(privateEvent));
fake.send(privateEvent);
console.log("投递 notice 事件：", JSON.stringify(noticeEvent));
fake.send(noticeEvent);
await new Promise((r) => setTimeout(r, 500));

console.log("对照投递 group 事件：", JSON.stringify(groupEvent.message));
fake.send(groupEvent);
await waitFor(() => received.length >= 1, 3000);
await new Promise((r) => setTimeout(r, 200));

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

check("private 与 notice 未触发 onMessage", received.length === 1, `onMessage 次数=${received.length}`);
check("只收下 group 消息", received[0]?.text === "对照组：这条应该被收下", received[0]?.text);
check("无未捕获异常", crashes.length === 0);

live.stop();
await fake.close();
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
