// 自测 2：[text, at(all), image, file] 混合 segment 的归一化结果。
import { createFakeOneBot, waitFor, watchCrash } from "./fake-onebot.mjs";
import { startLive } from "../napcat.js";

const crashes = watchCrash();
const received = [];
const fake = await createFakeOneBot().listen();
const live = startLive({
  env: { LIVE_ENABLED: "on", NAPCAT_WS_URL: fake.url, NAPCAT_ACCESS_TOKEN: "" },
  onMessage: (message) => received.push(message),
});
await waitFor(() => live.status().connected, 3000);

const event = {
  time: 1793000000,
  self_id: 10086,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: 9517,
  group_id: 723456789,
  group_name: "示例放行群",
  user_id: 10001,
  sender: { user_id: 10001, nickname: "罗雨", card: "罗雨" },
  raw_message: "大家好[CQ:at,qq=all][CQ:image,file=a.jpg][CQ:file,file=附件6.pdf]",
  message: [
    { type: "text", data: { text: "大家好" } },
    { type: "at", data: { qq: "all" } },
    { type: "image", data: { file: "a.jpg", url: "https://example.invalid/a.jpg" } },
    { type: "file", data: { file: "附件6.pdf", file_size: 20480 } },
  ],
};

console.log("投递前（OneBot 原始事件）：");
console.log(JSON.stringify(event, null, 2));
fake.send(event);
await waitFor(() => received.length === 1, 3000);
// 同一条事件再投一次，验证按 id 去重
fake.send(event);
await new Promise((r) => setTimeout(r, 300));

console.log("\n归一化后（SPEC §3 Message）：");
console.log(JSON.stringify(received[0], null, 2));

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const message = received[0] ?? {};
check("text 拼接正确", message.text === "@全体成员大家好【图片】【文件】附件6.pdf", message.text);
check("kind 判定", ["at_all", "mixed"].includes(message.kind), message.kind);
check("groupName", message.groupName === "示例放行群", message.groupName);
check("sender 取群名片", message.sender === "罗雨", message.sender);
check("source", message.source === "napcat", message.source);
check("ts 为北京时间", message.ts === "2026-10-26T15:33:20+08:00", message.ts);
check("id 形如 m_+12位", /^m_[0-9a-f]{12}$/.test(String(message.id)), message.id);
check("attachment 取文件名", message.attachment?.name === "附件6.pdf", JSON.stringify(message.attachment));
check("raw 保留原始事件且有长度上限", message.raw.includes("\"message_id\":9517") && message.raw.length <= 2000);
check("重复事件按 id 去重", received.length === 1, `onMessage 次数=${received.length}`);
check("无未捕获异常", crashes.length === 0);

live.stop();
await fake.close();
console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
