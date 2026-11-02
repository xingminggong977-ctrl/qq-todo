// 自测⑥：丢弃量进入 runs.json 与 stats()（totalDropped 持久化计数，不因 runs 截断而缩水）。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-dropped-"));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const run = (startedAt, droppedCount, extra = {}) => ({
  kind: "extract",
  startedAt,
  finishedAt: startedAt,
  processed: 200,
  todos: 13,
  provider: "openai",
  ...(droppedCount === undefined ? {} : { droppedCount }),
  ...extra,
});

try {
  console.log(`临时 DATA_DIR: ${dataDir}`);
  let store = createStore({ dataDir });

  await store.addRun(run("2026-11-01T09:00:00+08:00", 0, { modelCalls: 10 }));
  await store.addRun(run("2026-11-01T09:01:00+08:00", 78, { modelCalls: 61 }));
  await store.addRun(run("2026-11-01T09:02:00+08:00", 5, { modelCalls: 12 }));
  await store.flush();

  let st = store.getStats();
  const runs = store.listRuns();
  console.log(`runs: ${runs.map((r) => `dropped=${r.droppedCount}/calls=${r.modelCalls}`).join(" | ")}`);
  console.log(`stats: totalDropped=${st.totalDropped} lastDropped=${st.lastDropped}`);
  check("totalDropped = 83（0+78+5）", st.totalDropped === 83, `实际 ${st.totalDropped}`);
  check("lastDropped = 5（最近一轮）", st.lastDropped === 5, `实际 ${st.lastDropped}`);
  check("三条 run 都落了 droppedCount", runs.length === 3 && runs.every((r) => typeof r.droppedCount === "number"));
  check("三条 run 都落了 modelCalls", runs.every((r) => typeof r.modelCalls === "number"));
  check("counts 等老字段没被改坏", typeof st.counts?.todos === "number" && typeof st.funnel?.messagesProcessed === "number");

  // 换一个 store 实例重读磁盘：证明计数器是持久化的，不是内存里现算的
  store = createStore({ dataDir });
  st = store.getStats();
  check("重开 store 后 totalDropped 仍为 83（已持久化）", st.totalDropped === 83, `实际 ${st.totalDropped}`);

  // 旧结构 run（没有 droppedCount / modelCalls）：不许抛错，累计值不许变
  let legacyError = null;
  try {
    await store.addRun({ kind: "extract", startedAt: "2026-11-01T09:03:00+08:00", processed: 150, todos: 9, provider: "openai" });
    await store.flush();
  } catch (err) {
    legacyError = err;
  }
  st = store.getStats();
  const legacyRun = store.listRuns()[0];
  console.log(`legacy run: dropped=${legacyRun.droppedCount}/calls=${legacyRun.modelCalls} → totalDropped=${st.totalDropped} lastDropped=${st.lastDropped}`);
  check("旧结构 run 不抛错", legacyError === null, legacyError ? legacyError.message : "无异常");
  check("旧结构 run 按 0 处理", legacyRun.droppedCount === 0 && legacyRun.modelCalls === 0);
  check("旧结构 run 不改变 totalDropped", st.totalDropped === 83, `实际 ${st.totalDropped}`);

  // 继续灌到超过 MAX_RUNS(50)：截断后若还按 runs 重算，totalDropped 会缩水
  for (let i = 0; i < 55; i += 1) {
    await store.addRun(run(`2026-11-02T10:${String(i).padStart(2, "0")}:00+08:00`, 1));
  }
  await store.flush();
  st = store.getStats();
  const kept = store.listRuns(500);
  const keptSum = kept.reduce((sum, r) => sum + r.droppedCount, 0);
  console.log(`可留 ${kept.length} 条 run，其 droppedCount 之和 = ${keptSum}；stats.totalDropped = ${st.totalDropped}`);
  check("runs 被截断到 50 条", kept.length === 50, `实际 ${kept.length}`);
  check("totalDropped = 138（83+55，不随截断缩水）", st.totalDropped === 138, `实际 ${st.totalDropped}`);
  check("截断后可见 run 之和 < totalDropped（证明不是重算）", keptSum < st.totalDropped, `${keptSum} < ${st.totalDropped}`);
  check("lastDropped 跟随最近一轮", st.lastDropped === 1, `实际 ${st.lastDropped}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n清理临时目录: ${dataDir}`);
  if (failed) process.exitCode = 1;
}
