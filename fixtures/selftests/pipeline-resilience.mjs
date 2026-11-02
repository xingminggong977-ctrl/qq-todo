// 自测⑤：提取管线的有界兜底链（重试 → 拆批 → dropped 记账 + maxCalls 护栏）。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { seedMessages } from "../../src/ingest/mock.js";
import { runExtract } from "../../src/extract/pipeline.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-resilience-"));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

// 假 provider：把 items 造成合法分类结果，todo 一律 false（这里只验证「有没有结果」）
// meta.parseOk=false 模拟「响应截断 / JSON 解析不出来」——只有这种才该触发重试与拆批。
function makeFake(name, plan, meta = {}) {
  let calls = 0;
  const covered = new Set();
  return {
    name,
    model: name,
    get calls() {
      return calls;
    },
    get covered() {
      return covered;
    },
    async classify(batch) {
      calls += 1;
      const ids = plan(batch, calls);
      const items = ids.map((messageId) => {
        covered.add(messageId);
        return { messageId, todo: false, title: "x", deadline: null, constraints: [], confidence: 0.5, reason: "fake" };
      });
      return { items, provider: name, model: name, costUsd: 0, parseOk: meta.parseOk !== false, finishReason: meta.finishReason ?? null };
    },
  };
}

try {
  const store = createStore({ dataDir });
  const seedA = await seedMessages(store, 25);
  console.log(`临时 DATA_DIR: ${dataDir}`);
  console.log(`mock 灌入: imported=${seedA.imported} skipped=${seedA.skipped}`);

  const seededIds = store.listMessages({ limit: 0 }).items.map((m) => m.id);
  console.log(`库里消息数: ${seededIds.length}`);

  // ① 第 2 批「模型只给 1 条、而且重试也不改口径」：必须靠拆批一路救回来
  const hostile = new Set(seededIds.slice(10, 20));
  const flaky = makeFake("fake-flaky", (batch) => {
    const ids = batch.map((m) => m.id);
    const touchesHostileBatch = ids.some((id) => hostile.has(id));
    return touchesHostileBatch && ids.length >= 4 ? ids.slice(0, 1) : ids;
  }, { parseOk: false });
  const r1 = await runExtract({ env: { DATA_DIR: dataDir }, store, provider: flaky, batchSize: 10, concurrency: 1, retryDelayMs: 10 });
  console.log("");
  console.log(`① 残缺 provider: modelCalls=${r1.modelCalls} processed=${r1.processed} droppedCount=${r1.droppedCount} durationMs=${r1.durationMs}`);
  console.log(`   errors: ${JSON.stringify(r1.errors, null, 0)}`);
  check("① dropped 为空（拆批后全部救回）", r1.droppedCount === 0, `droppedCount=${r1.droppedCount}`);
  check("① 调用次数 ≤ maxCalls", r1.modelCalls <= r1.maxCalls, `modelCalls=${r1.modelCalls} maxCalls=${r1.maxCalls}`);
  check("① 25 条消息全部有结果", flaky.covered.size === seededIds.length && r1.processed === seededIds.length, `covered=${flaky.covered.size} processed=${r1.processed} seeded=${seededIds.length}`);
  check("① 有「拆成」的人话日志", r1.errors.some((e) => e.includes("拆成")), r1.errors.find((e) => e.includes("拆成")) || "(无)");

  // ② 永远返回残缺（0 条）：全部落 dropped，整轮不抛异常
  const dead = makeFake("fake-dead", () => [], { parseOk: false });
  const t2 = Date.now();
  let r2 = null;
  let threw = null;
  try {
    r2 = await runExtract({ env: { DATA_DIR: dataDir }, store, provider: dead, batchSize: 10, concurrency: 1, retryDelayMs: 10, force: true });
  } catch (err) {
    threw = err;
  }
  const elapsed2 = Date.now() - t2;
  console.log("");
  console.log(`② 全残缺 provider: modelCalls=${r2?.modelCalls} droppedCount=${r2?.droppedCount} droppedMessageIds=${r2?.droppedMessageIds.length} 耗时=${elapsed2}ms`);
  console.log(`   errors 尾条: ${r2?.errors[r2.errors.length - 1]}`);
  check("② 整轮不抛异常", threw === null, threw ? threw.message : "无异常");
  check("② droppedCount 等于输入数", r2?.droppedCount === seededIds.length, `droppedCount=${r2?.droppedCount} seeded=${seededIds.length}`);
  check("② droppedMessageIds 有内容且不超过 50", (r2?.droppedMessageIds.length || 0) === seededIds.length && r2.droppedMessageIds.length <= 50);
  check("② 调用次数 ≤ maxCalls（护栏生效）", (r2?.modelCalls || 0) <= (r2?.maxCalls || 0), `modelCalls=${r2?.modelCalls} maxCalls=${r2?.maxCalls}`);
  check("② 日志写明达到调用上限", (r2?.errors || []).some((e) => e.includes("达到调用上限")));
  check("② 耗时正常（< 20s）", elapsed2 < 20000, `${elapsed2}ms`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n清理临时目录: ${dataDir}`);
  if (failed) process.exitCode = 1;
}
