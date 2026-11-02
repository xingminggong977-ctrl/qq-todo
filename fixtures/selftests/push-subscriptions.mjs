// 自测⑭：Web Push 订阅落库（addPushSubscription / removePushSubscription / listPushSubscriptions）。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-push-"));
const legacyDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-push-legacy-"));
let failed = false;
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

// 可注入时钟：断言 updatedAt 真的变了，不受「两次调用落在同一毫秒」影响
let clock = Date.parse("2026-10-11T09:20:00+08:00");
const tick = (ms = 1000) => {
  clock += ms;
  return clock;
};
const expectedId = (endpoint) => `push_${createHash("sha1").update(endpoint).digest("hex").slice(0, 12)}`;
const sub = (name, over = {}) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: `p256dh-${name}`, auth: `auth-${name}` },
  ua: `Mozilla/5.0 ${name}`,
  ...over,
});
const throwsInvalid = async (fn) => {
  try {
    await fn();
    return "no-throw";
  } catch (err) {
    return err.message;
  }
};

try {
  const store = createStore({ dataDir, now: () => clock });

  const first = await store.addPushSubscription(sub("alpha"));
  check("首次订阅 created:true", first.created === true, JSON.stringify(first));
  check("id = push_ + sha1(endpoint)[0:12]", first.id === expectedId(sub("alpha").endpoint), first.id);

  const listed = store.listPushSubscriptions();
  const row = listed.items[0];
  check("listPushSubscriptions 返回 1 条", listed.items.length === 1, String(listed.items.length));
  check(
    "字段齐全（id/endpoint/keys/ua/createdAt/updatedAt）",
    Boolean(row?.id && row?.endpoint && row?.keys?.p256dh && row?.keys?.auth && row?.ua && row?.createdAt && row?.updatedAt),
    JSON.stringify({ id: row?.id, createdAt: row?.createdAt, updatedAt: row?.updatedAt }),
  );
  const createdAtFirst = row.createdAt;
  const updatedAtFirst = row.updatedAt;

  // 同一 endpoint 再来一次：只更新 keys/ua/updatedAt
  tick();
  const second = await store.addPushSubscription(sub("alpha", { keys: { p256dh: "p256dh-alpha-v2", auth: "auth-alpha-v2" }, ua: "Chrome 131" }));
  check("同 endpoint 二次 created:false", second.created === false, JSON.stringify(second));
  check("同 endpoint 二次 id 不变", second.id === first.id, second.id);
  const after = store.listPushSubscriptions().items;
  check("同 endpoint 二次不新增行", after.length === 1, String(after.length));
  check("keys 被更新", after[0].keys.p256dh === "p256dh-alpha-v2" && after[0].keys.auth === "auth-alpha-v2", JSON.stringify(after[0].keys));
  check("ua 被更新", after[0].ua === "Chrome 131", after[0].ua);
  check("createdAt 不变", after[0].createdAt === createdAtFirst, after[0].createdAt);
  check("updatedAt 前进了", after[0].updatedAt !== updatedAtFirst, `${updatedAtFirst} → ${after[0].updatedAt}`);

  // 两个不同 endpoint 各自独立
  tick();
  const beta = await store.addPushSubscription(sub("beta"));
  check("第二个 endpoint created:true", beta.created === true, JSON.stringify(beta));
  check("两条订阅 id 不同", beta.id !== first.id, `${first.id} / ${beta.id}`);
  check("总数 2", store.listPushSubscriptions().items.length === 2, String(store.listPushSubscriptions().items.length));

  // 非法入参
  check("endpoint 为空 → invalid_subscription", (await throwsInvalid(() => store.addPushSubscription(sub("x", { endpoint: "  " })))) === "invalid_subscription");
  check("endpoint 非字符串 → invalid_subscription", (await throwsInvalid(() => store.addPushSubscription(sub("x", { endpoint: 123 })))) === "invalid_subscription");
  check("keys 缺 p256dh → invalid_subscription", (await throwsInvalid(() => store.addPushSubscription(sub("x", { keys: { auth: "a" } })))) === "invalid_subscription");
  check("keys 缺 auth → invalid_subscription", (await throwsInvalid(() => store.addPushSubscription(sub("x", { keys: { p256dh: "p" } })))) === "invalid_subscription");
  check("keys 为 null → invalid_subscription", (await throwsInvalid(() => store.addPushSubscription(sub("x", { keys: null })))) === "invalid_subscription");
  check("没有入参 → invalid_subscription", (await throwsInvalid(() => store.addPushSubscription())) === "invalid_subscription");
  check("非法入参没有污染存储", store.listPushSubscriptions().items.length === 2, String(store.listPushSubscriptions().items.length));

  // 返回的是副本：改返回值不该改到库里
  const snapshot = store.listPushSubscriptions().items;
  snapshot[0].keys.p256dh = "tampered";
  check("listPushSubscriptions 返回副本", store.listPushSubscriptions().items[0].keys.p256dh !== "tampered");

  // 上限 20：第 21 条把最旧的挤掉
  const bulkDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-push-bulk-"));
  try {
    const bulk = createStore({ dataDir: bulkDir, now: () => clock });
    for (let i = 1; i <= 21; i += 1) {
      tick(1000);
      await bulk.addPushSubscription(sub(`bulk-${String(i).padStart(2, "0")}`));
    }
    const items = bulk.listPushSubscriptions().items;
    const endpoints = items.map((it) => it.endpoint);
    check("21 条订阅后总数 = 20", items.length === 20, String(items.length));
    check("最旧的被淘汰", !endpoints.includes(sub("bulk-01").endpoint), endpoints[0]);
    check("最新的还在", endpoints.includes(sub("bulk-21").endpoint));
  } finally {
    rmSync(bulkDir, { recursive: true, force: true });
  }

  // 删除
  check("按 id 删返回 true", (await store.removePushSubscription(first.id)) === true);
  check("按 endpoint 删返回 true", (await store.removePushSubscription(sub("beta").endpoint)) === true);
  check("删不存在的返回 false", (await store.removePushSubscription("push_deadbeef0000")) === false);
  check("删不存在的 endpoint 返回 false", (await store.removePushSubscription("https://example.com/none")) === false);
  check("删完订阅为空", store.listPushSubscriptions().items.length === 0, String(store.listPushSubscriptions().items.length));

  // 统计口径
  tick();
  await store.addPushSubscription(sub("gamma"));
  tick();
  await store.addPushSubscription(sub("delta"));
  const st = store.getStats();
  check("getStats().push.subscriptions 与实际条数一致", st.push?.subscriptions === 2, JSON.stringify(st.push));
  check("push 没被塞进 counts", st.counts.push === undefined, JSON.stringify(Object.keys(st.counts)));

  // 重启（新实例读同一份磁盘）后仍在
  const reopened = createStore({ dataDir, now: () => clock });
  const restored = reopened.listPushSubscriptions().items;
  check("重启后订阅仍在", restored.length === 2, String(restored.length));
  check("重启后 keys 完好", restored.every((it) => it.keys.p256dh && it.keys.auth), "keys ok");
  check("重启后统计仍一致", reopened.getStats().push.subscriptions === 2, JSON.stringify(reopened.getStats().push));

  // 老 store.json（没有 pushSubscriptions 字段）
  writeFileSync(
    path.join(legacyDir, "store.json"),
    JSON.stringify({ version: 1, messages: [], todos: [], runs: [], corrections: [], totalDropped: 0, decisions: [], groupSettings: {} }),
    "utf8",
  );
  const legacy = createStore({ dataDir: legacyDir, now: () => clock });
  let legacyErr = null;
  try {
    check("老格式读出空数组", legacy.listPushSubscriptions().items.length === 0, "0");
    check("老格式 stats.push 为 0", legacy.getStats().push.subscriptions === 0, JSON.stringify(legacy.getStats().push));
    tick();
    await legacy.addPushSubscription(sub("legacy"));
    check("老格式能写新订阅", legacy.listPushSubscriptions().items.length === 1, String(legacy.listPushSubscriptions().items.length));
    const reopenedLegacy = createStore({ dataDir: legacyDir, now: () => clock });
    check("写回后重新打开仍在", reopenedLegacy.listPushSubscriptions().items.length === 1);
  } catch (err) {
    legacyErr = err;
  }
  check("老格式读写全程不抛错", legacyErr === null, String(legacyErr?.message));

  console.log(failed ? `\nPASS=${pass} FAIL=${fail}\n存在失败用例` : `\nPASS=${pass} FAIL=0\n全部 PASS`);
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
}
