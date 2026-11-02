// 自测 5：GROUP_ALLOWLIST 生效，白名单外的群消息被丢弃。
import { createFakeOneBot, waitFor, watchCrash } from "./fake-onebot.mjs";
import { startLive } from "../napcat.js";

const crashes = watchCrash();
const received = [];
const fake = await createFakeOneBot().listen();
const live = startLive({
  env: {
    LIVE_ENABLED: "on",
    NAPCAT_WS_URL: fake.url,
    GROUP_ALLOWLIST: " 示例放行群 , 另一个放行的群 ",
  },
  onMessage: (message) => received.push(message),
});
await waitFor(() => live.status().connected, 3000);

function groupEvent(groupName, groupId, text) {
  return {
    time: 1793000500,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 9700,
    group_id: groupId,
    group_name: groupName,
    user_id: 10001,
    sender: { nickname: "罗雨" },
    message: [{ type: "text", data: { text } }],
  };
}

console.log("投递白名单外群消息：隔壁班灌水群");
fake.send(groupEvent("隔壁班灌水群", 700000001, "今晚开黑吗"));
await new Promise((r) => setTimeout(r, 600));
console.log(`白名单外消息后 onMessage 次数=${received.length}`);

console.log("投递白名单内群消息：示例放行群");
fake.send(groupEvent("示例放行群", 723456789, "明天交表"));
await waitFor(() => received.length === 1, 3000);
console.log(`白名单内消息后 onMessage 次数=${received.length}，groups=${JSON.stringify(live.status().groups)}`);

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

check("白名单外群消息被丢弃", received.length === 1, `onMessage 次数=${received.length}`);
check("只收下白名单群", received[0]?.groupName === "示例放行群", received[0]?.groupName);
check(
  "status().groups 只反映白名单内群",
  JSON.stringify(live.status().groups) === JSON.stringify(["示例放行群"]),
  JSON.stringify(live.status().groups),
);
check("无未捕获异常", crashes.length === 0);

live.stop();
await fake.close();
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
