// 自测⑨：决策日志（decisions）+ 群级设置（groupSettings）。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-decisions-"));
const legacyDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-decisions-legacy-"));
const bigDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-decisions-big-"));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const decision = (over = {}) => ({
  messageId: over.messageId,
  groupName: over.groupName ?? "计科2201班级群",
  at: over.at ?? "2026-10-11T09:20:00+08:00",
  verdict: over.verdict ?? "todo",
  reason: over.reason ?? "有截止时间且是任务",
  model: over.model ?? "qwen-plus",
  confidence: over.confidence ?? 0.86,
  todoId: over.todoId ?? null,
});

const todo = (over = {}) => ({
  messageId: over.messageId,
  title: over.title ?? "提交实践报告",
  deadline: over.deadline === undefined ? "2026-10-16" : over.deadline,
  deadlineText: "本周五前",
  constraints: ["学习通"],
  confidence: 0.8,
  reason: "有截止时间",
  source: { groupName: over.groupName ?? "计科2201班级群", sender: "辅导员", ts: over.ts ?? "2026-10-11T09:20:00+08:00" },
  model: "qwen-plus",
});

try {
  console.log(`临时 DATA_DIR: ${dataDir}`);
  const store = createStore({ dataDir });

  // ① 写 3 条，再覆盖写第 2 条 → total 仍是 3，被覆盖那条的 reason 变了
  await store.recordDecisions([
    decision({ messageId: "m_d1", verdict: "todo" }),
    decision({ messageId: "m_d2", verdict: "noise", reason: "闲聊", confidence: 0.2 }),
    decision({ messageId: "m_d3", verdict: "implicit", reason: "模型判为非待办", confidence: 0.5 }),
  ]);
  const first = store.listDecisions({ limit: 0 });
  await store.recordDecisions([decision({ messageId: "m_d2", verdict: "dropped", reason: "重试后仍缺，记入 dropped", confidence: 0.9 })]);
  const after = store.listDecisions({ limit: 0 });
  const d2 = after.items.find((d) => d.messageId === "m_d2");
  console.log(`① before.total=${first.total} after.total=${after.total} d2=${JSON.stringify({ verdict: d2?.verdict, reason: d2?.reason })}`);
  check("① 覆盖写不增加 total", first.total === 3 && after.total === 3, `${first.total} → ${after.total}`);
  check("① 被覆盖那条 reason 已更新", d2?.reason === "重试后仍缺，记入 dropped", d2?.reason);
  check("① 被覆盖那条 verdict 已更新", d2?.verdict === "dropped", d2?.verdict);

  // ③ 按 verdict 过滤（放在大涨之前，保证只看这 3 条）
  const droppedOnly = store.listDecisions({ verdict: "dropped" });
  console.log(`③ dropped=${droppedOnly.total} verdicts=${JSON.stringify(droppedOnly.items.map((d) => d.verdict))}`);
  check("③ verdict=dropped 只返回 dropped", droppedOnly.total === 1 && droppedOnly.items.every((d) => d.verdict === "dropped"), `实际 ${droppedOnly.total}`);
  const byGroupFilter = store.listDecisions({ groupName: "不存在的群" });
  check("③ groupName 过滤可用", byGroupFilter.total === 0, `实际 ${byGroupFilter.total}`);

  // ④ 群级屏蔽：blocked 群的 todo 从 listTodos 与 counts.todos 里消失，恢复后回来
  await store.addTodos([
    todo({ messageId: "m_g1", groupName: "计科2201班级群", title: "交实验报告" }),
    todo({ messageId: "m_g2", groupName: "贵大跑团", title: "周日在北校区集合", deadline: "2026-10-12" }),
  ]);
  const beforeBlock = store.listTodos({ status: "pending" }).items.length;
  const beforeCounts = store.counts();
  const beforeDue = store.getStats().dueSoon.map((t) => t.title);
  await store.setGroupMode("贵大跑团", "blocked");
  const blockedList = store.listTodos({ status: "pending" }).items;
  const blockedCounts = store.counts();
  const blockedStats = store.getStats();
  console.log(`④ before=${beforeBlock} after=${blockedList.length} counts.todos ${beforeCounts.todos} → ${blockedCounts.todos} dueSoon ${JSON.stringify(beforeDue)} → ${JSON.stringify(blockedStats.dueSoon.map((t) => t.title))}`);
  check("④ blocked 群的 todo 从 listTodos 消失", blockedList.length === beforeBlock - 1 && !blockedList.some((t) => t.source.groupName === "贵大跑团"), `${beforeBlock} → ${blockedList.length}`);
  check("④ counts.todos 也减 1", blockedCounts.todos === beforeCounts.todos - 1, `${beforeCounts.todos} → ${blockedCounts.todos}`);
  check("④ dueSoon 里没有 blocked 群", beforeDue.includes("周日在北校区集合") && !blockedStats.dueSoon.some((t) => t.title === "周日在北校区集合"), JSON.stringify(blockedStats.dueSoon.map((t) => t.title)));
  check("④ getGroupSettings 反映了设置", store.getGroupSettings()["贵大跑团"]?.mode === "blocked", JSON.stringify(store.getGroupSettings()));
  await store.setGroupMode("贵大跑团", "normal");
  const restored = store.listTodos({ status: "pending" }).items;
  const restoredCounts = store.counts();
  console.log(`④ 恢复后 list=${restored.length} counts.todos=${restoredCounts.todos} settings=${JSON.stringify(store.getGroupSettings())}`);
  check("④ 设回 normal 后全部回来", restored.length === beforeBlock && restoredCounts.todos === beforeCounts.todos, `${restored.length} / ${restoredCounts.todos}`);
  let modeErr = null;
  try {
    await store.setGroupMode("贵大跑团", "silent");
  } catch (err) {
    modeErr = err;
  }
  check("④ 非法 mode 抛 invalid_mode", modeErr?.message === "invalid_mode", String(modeErr?.message));

  // ② 超 2000 条后最老的被丢（分批写，等价逐条写 2001 条）
  const bigStore = createStore({ dataDir: bigDir });
  const t0 = Date.now();
  for (let start = 0; start < 2001; start += 100) {
    const chunk = [];
    for (let i = start; i < Math.min(start + 100, 2001); i += 1) {
      chunk.push(decision({ messageId: `m_big_${i}`, verdict: i % 2 ? "noise" : "implicit", reason: `第 ${i} 条`, at: `2026-10-11T09:${String(i % 60).padStart(2, "0")}:00+08:00` }));
    }
    await bigStore.recordDecisions(chunk);
  }
  const big = bigStore.listDecisions({ limit: 0 });
  const bigIds = new Set(big.items.map((d) => d.messageId));
  console.log(`② total=${big.total} 最老还在=${bigIds.has("m_big_0")} 最新还在=${bigIds.has("m_big_2000")} 耗时=${Date.now() - t0}ms`);
  check("② 超上限后 length = 2000", big.total === 2000, `实际 ${big.total}`);
  check("② 最老的一条被丢弃", !bigIds.has("m_big_0"), "m_big_0 不在");
  check("② 最新的一条还在", bigIds.has("m_big_2000"), "m_big_2000 在");

  // stats().decisions 汇总
  await store.flush();
  const stats = store.getStats();
  console.log(`stats.decisions=${JSON.stringify(stats.decisions)}`);
  check("stats.decisions.total 与库里一致", stats.decisions.total === store.listDecisions({ limit: 0 }).total, `${stats.decisions.total}`);
  check("stats.decisions.byVerdict 五个键齐全", ["todo", "dropped", "noise", "implicit", "error"].every((k) => typeof stats.decisions.byVerdict[k] === "number"), JSON.stringify(stats.decisions.byVerdict));

  // ⑤ 老 store.json（无 decisions / groupSettings）能读能写
  const legacy = {
    version: 1,
    messages: [],
    todos: [
      {
        id: "t_old",
        messageId: "m_old",
        title: "老格式待办",
        deadline: "2026-10-20",
        deadlineText: "10月20日",
        constraints: [],
        confidence: 0.7,
        reason: "老数据",
        status: "pending",
        source: { groupName: "计科2201班级群", sender: "辅导员", ts: "2026-10-11T09:20:00+08:00" },
        model: "rules-v1",
        createdAt: "2026-10-11T09:20:00+08:00",
        updatedAt: "2026-10-11T09:20:00+08:00",
        doneAt: null,
        dismissedAt: null,
      },
    ],
    runs: [],
    corrections: [],
  };
  writeFileSync(path.join(legacyDir, "store.json"), JSON.stringify(legacy));
  let legacyErr = null;
  try {
    const legacyStore = createStore({ dataDir: legacyDir });
    const items = legacyStore.listTodos({ status: "pending" }).items;
    const legacyDecisions = legacyStore.listDecisions({ limit: 0 });
    const legacySettings = legacyStore.getGroupSettings();
    console.log(`⑤ legacy todos=${items.length} decisions=${legacyDecisions.total} settings=${JSON.stringify(legacySettings)}`);
    check("⑤ 老格式能读、待办数不变", items.length === 1, `实际 ${items.length}`);
    check("⑤ 缺 decisions 时补成空列表", legacyDecisions.total === 0, `实际 ${legacyDecisions.total}`);
    check("⑤ 缺 groupSettings 时补成空对象", Object.keys(legacySettings).length === 0, JSON.stringify(legacySettings));
    check("⑤ 老格式 stats.decisions.byVerdict 全 0", legacyStore.getStats().decisions.byVerdict.todo === 0, JSON.stringify(legacyStore.getStats().decisions));
    await legacyStore.recordDecisions([decision({ messageId: "m_legacy_new", verdict: "todo" })]);
    await legacyStore.setGroupMode("计科2201班级群", "quiet");
    await legacyStore.flush();
    const written = JSON.parse(readFileSync(path.join(legacyDir, "store.json"), "utf8"));
    console.log(`⑤ 写回后字段=${JSON.stringify(Object.keys(written))} decisions=${written.decisions?.length} settings=${JSON.stringify(written.groupSettings)}`);
    check("⑤ 写回后文件里有 decisions", Array.isArray(written.decisions) && written.decisions.length === 1, String(written.decisions?.length));
    check("⑤ 写回后文件里有 groupSettings", written.groupSettings?.["计科2201班级群"]?.mode === "quiet", JSON.stringify(written.groupSettings));
  } catch (err) {
    legacyErr = err;
  }
  check("⑤ 老格式读写全程不抛错", legacyErr === null, String(legacyErr?.message));

  console.log(failed ? "\n存在失败用例" : "\n全部 PASS");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
  rmSync(bigDir, { recursive: true, force: true });
}
