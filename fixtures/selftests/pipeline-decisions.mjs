// 自测⑩：pipeline 产出 decisions（决策日志），每条输入消息一条。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { seedMessages } from "../../src/ingest/mock.js";
import { runExtract } from "../../src/extract/pipeline.js";

const bigDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-decisions-273-"));
const dropDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-decisions-drop-"));
const errDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-decisions-err-"));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const tally = (decisions) => {
  const out = { todo: 0, dropped: 0, noise: 0, implicit: 0, error: 0 };
  for (const d of decisions) out[d.verdict] = (out[d.verdict] || 0) + 1;
  return out;
};
const message = (over = {}) => ({
  id: over.id,
  groupName: over.groupName ?? "电路原理(1班)",
  sender: over.sender ?? "辅导员",
  ts: over.ts ?? "2026-10-11T09:20:00+08:00",
  text: over.text ?? "请各位同学本周五前把实验报告交到学习通，逾期不候",
  kind: over.kind ?? "text",
  noise: over.noise ?? false,
});

try {
  // ① 273 条 mock + stub：decisions 覆盖每条消息，todo 数与 todosCreated 一致
  const store = createStore({ dataDir: bigDir });
  await seedMessages(store, 273);
  const run1 = await runExtract({ env: { DATA_DIR: bigDir }, store });
  const counts1 = tally(run1.decisions);
  console.log(`① messages=273 decisions=${run1.decisions.length} todosCreated=${run1.todosCreated} byVerdict=${JSON.stringify(counts1)}`);
  check("① decisions.length = 273（每条输入消息一条）", run1.decisions.length === 273, `实际 ${run1.decisions.length}`);
  check("① byVerdict 五个键齐全", ["todo", "dropped", "noise", "implicit", "error"].every((k) => typeof counts1[k] === "number"), JSON.stringify(counts1));
  check("① todo 数 = todosCreated", counts1.todo === run1.todosCreated, `${counts1.todo} vs ${run1.todosCreated}`);
  check("① 每条 decision 字段齐全", run1.decisions.every((d) => ["messageId", "groupName", "at", "verdict", "reason", "model", "confidence", "todoId"].every((k) => k in d)), "ok");
  check("① todo 决策的 model 写 stub", run1.decisions.filter((d) => d.verdict === "todo").every((d) => d.model === "stub"), "stub");
  check("① 入库即判闲聊的那批记为 noise 且未送模型", run1.decisions.some((d) => d.reason === "入库时已标记为闲聊，未送模型" && d.model === null), `${counts1.noise} 条 noise`);
  check("① 一条决策对应一条消息（messageId 不重复）", new Set(run1.decisions.map((d) => d.messageId)).size === run1.decisions.length, `${run1.decisions.length}`);
  // 与 store 的字段契约对得上：直接灌进 recordDecisions 就能查
  const wrote = await store.recordDecisions(run1.decisions);
  const listed = store.listDecisions({ limit: 0 });
  const statsDecisions = store.getStats().decisions;
  console.log(`① 落库 written=${wrote.written} total=${wrote.total} listDecisions=${listed.total} stats=${JSON.stringify(statsDecisions.byVerdict)}`);
  check("① decisions 可直接灌进 recordDecisions", wrote.total === 273 && listed.total === 273, `${wrote.total}/${listed.total}`);
  check("① 落库后 stats.decisions.byVerdict 与本次一致", statsDecisions.byVerdict.todo === counts1.todo && statsDecisions.byVerdict.noise === counts1.noise, JSON.stringify(statsDecisions.byVerdict));
  check("① 落库后可解释「为什么没成待办」", listed.items.some((d) => d.verdict === "noise" && d.reason.length > 0), listed.items.find((d) => d.verdict === "noise")?.reason);

  // ④ 幂等：同一批 force 再跑一次，decisions 条数不翻倍
  const run2 = await runExtract({ env: { DATA_DIR: bigDir }, store, force: true });
  console.log(`④ run1=${run1.decisions.length} run2=${run2.decisions.length} ids1=${new Set(run1.decisions.map((d) => d.messageId)).size}`);
  check("④ 同一批跑两次 decisions 条数不翻倍", run2.decisions.length === run1.decisions.length, `${run1.decisions.length} → ${run2.decisions.length}`);
  check("④ 两次的 messageId 集合一致", new Set(run2.decisions.map((d) => d.messageId)).size === new Set(run1.decisions.map((d) => d.messageId)).size, "ok");

  // ② 模型漏条（解析成功但反复不给）→ 该条记 dropped，reason 非空
  const dropStore = createStore({ dataDir: dropDir });
  await dropStore.addMessages([message({ id: "m_keep1" }), message({ id: "m_skip", text: "通知：10月12日24点前交作业" }), message({ id: "m_keep2" })]);
  const partial = {
    name: "partial",
    kind: "openai",
    model: "fake-model",
    async classify(batch) {
      const items = batch
        .filter((m) => m.id !== "m_skip")
        .map((m) => ({ messageId: m.id, todo: !m.id.startsWith("m_note"), title: "交实验报告", deadline: "2026-10-16", deadlineText: "本周五前", constraints: [], confidence: 0.7, reason: "有截止时间" }));
      return { items, provider: "partial", model: "fake-model", costUsd: 0, parseOk: false, finishReason: null };
    },
  };
  const runDrop = await runExtract({ env: { DATA_DIR: dropDir }, store: dropStore, provider: partial, batchSize: 10, concurrency: 1, retryDelayMs: 5 });
  const skip = runDrop.decisions.find((d) => d.messageId === "m_skip");
  const dropTally = tally(runDrop.decisions);
  console.log(`② decisions=${runDrop.decisions.length} byVerdict=${JSON.stringify(dropTally)} m_skip=${JSON.stringify({ verdict: skip?.verdict, reason: skip?.reason })}`);
  check("② 模型漏掉的那条记为 dropped", skip?.verdict === "dropped", String(skip?.verdict));
  check("② dropped 的 reason 非空且可读", typeof skip?.reason === "string" && skip.reason.length > 0, skip?.reason);
  check("② dropped 的 confidence 为 null", skip?.confidence === null, String(skip?.confidence));
  check("② 其它条仍正常产出 todo", dropTally.todo >= 2, JSON.stringify(dropTally));

  // ②b 解析成功但没给 item → implicit（不重试、不算 dropped）
  const implicitDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-decisions-implicit-"));
  const impStore = createStore({ dataDir: implicitDir });
  await impStore.addMessages([message({ id: "m_i1" }), message({ id: "m_i2", text: "补充：只收 PDF，文件名按学号命名" })]);
  const sparse = {
    name: "sparse",
    kind: "openai",
    model: "fake-model",
    async classify(batch) {
      const items = batch
        .filter((m) => m.id === "m_i1")
        .map((m) => ({ messageId: m.id, todo: true, title: "交实验报告", deadline: "2026-10-16", deadlineText: "本周五前", constraints: [], confidence: 0.8, reason: "有截止时间" }));
      return { items, provider: "sparse", model: "fake-model", costUsd: 0, parseOk: true, finishReason: "stop" };
    },
  };
  const runImp = await runExtract({ env: { DATA_DIR: implicitDir }, store: impStore, provider: sparse, batchSize: 10, concurrency: 1, retryDelayMs: 5 });
  const implicitHit = runImp.decisions.find((d) => d.messageId === "m_i2");
  console.log(`②b decisions=${runImp.decisions.length} byVerdict=${JSON.stringify(tally(runImp.decisions))} modelCalls=${runImp.modelCalls} m_i2=${JSON.stringify({ verdict: implicitHit?.verdict, reason: implicitHit?.reason })}`);
  check("②b 解析成功的漏条记为 implicit", implicitHit?.verdict === "implicit", String(implicitHit?.verdict));
  check("②b implicit 不计入 dropped", runImp.droppedCount === 0, String(runImp.droppedCount));
  rmSync(implicitDir, { recursive: true, force: true });

  // ③ 调用失败 → error，且 run() 不抛
  const errStore = createStore({ dataDir: errDir });
  await errStore.addMessages([message({ id: "m_e1" }), message({ id: "m_e2" })]);
  const broken = {
    name: "broken",
    kind: "openai",
    model: "fake-model",
    async classify() {
      throw new Error("timeout");
    },
  };
  let thrown = null;
  let runErr = null;
  try {
    runErr = await runExtract({ env: { DATA_DIR: errDir }, store: errStore, provider: broken, batchSize: 10, concurrency: 1, retryDelayMs: 5 });
  } catch (err) {
    thrown = err;
  }
  const errTally = runErr ? tally(runErr.decisions) : null;
  console.log(`③ thrown=${thrown?.message ?? "none"} decisions=${runErr?.decisions.length} byVerdict=${JSON.stringify(errTally)} sample=${JSON.stringify(runErr?.decisions[0]?.reason)}`);
  check("③ run() 不抛（上游失败被吞成 decisions）", thrown === null, String(thrown?.message));
  check("③ 每条都记为 error", errTally?.error === 2, JSON.stringify(errTally));
  check("③ error 的 reason 带调用失败原因", runErr?.decisions.every((d) => /调用失败/.test(d.reason)), runErr?.decisions[0]?.reason);

  console.log(failed ? "\n存在失败用例" : "\n全部 PASS");
} finally {
  rmSync(bigDir, { recursive: true, force: true });
  rmSync(dropDir, { recursive: true, force: true });
  rmSync(errDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
