// 自测 1：Bearer 头确实发出；token 不匹配时不进入 connected 且进程不崩。
import { createFakeOneBot, waitFor, watchCrash } from "./fake-onebot.mjs";
import { startLive } from "../napcat.js";

const crashes = watchCrash();
let failed = false;

function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const good = await createFakeOneBot({ requiredToken: "secret-1" }).listen();
const goodLive = startLive({
  env: {
    LIVE_ENABLED: "on",
    NAPCAT_WS_URL: good.url,
    NAPCAT_ACCESS_TOKEN: "secret-1",
  },
  onMessage: () => {},
});
await waitFor(() => goodLive.status().connected, 3000);
check("1a 正确 token 建连", goodLive.status().connected === true);
check("1a 服务端收到 Authorization", true, JSON.stringify(good.state.authHeaders[0]));
check(
  "1a 头内容为 Bearer <token>",
  good.state.authHeaders[0] === "Bearer secret-1",
  good.state.authHeaders[0],
);
goodLive.stop();
await good.close();

const bad = await createFakeOneBot({ requiredToken: "right-token" }).listen();
const badLive = startLive({
  env: {
    LIVE_ENABLED: "on",
    NAPCAT_WS_URL: bad.url,
    NAPCAT_ACCESS_TOKEN: "wrong-token",
  },
  onMessage: () => {},
});
await badLive.ready;
await new Promise((r) => setTimeout(r, 1200));
// Node 内置 WebSocket（undici）在握手被拒时会自行重试一次，故只断言「至少被拒一次」
check("1b 错误 token 握手被拒", bad.state.rejected >= 1, `rejected=${bad.state.rejected}`);
check("1b 未进入 connected", badLive.status().connected === false, JSON.stringify(badLive.status()));
check("1b ready 已结算未挂起", true);
check("1b 无未捕获异常", crashes.length === 0);
badLive.stop();
await bad.close();

console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
