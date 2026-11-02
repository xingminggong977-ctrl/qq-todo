// 自测⑦：三分覆盖口径 —— 解析失败（重试/拆批/dropped）vs 解析成功但没给 item（implicit negative，不重试）。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { seedMessages } from "../../src/ingest/mock.js";
import { runExtract } from "../../src/extract/pipeline.js";

const root = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-threeway-"));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

// plan(batch, callNo) -> { ids, parseOk, finishReason }
function makeFake(name, plan) {
  let calls = 0;
  return {
    name,
    model: name,
    get calls() {
      return calls;
    },
    async classify(batch) {
      calls += 1;
      const { ids, parseOk = true, finishReason = "stop" } = plan(batch, calls);
      const items = ids.map((messageId) => ({
        messageId,
        todo: false,
        title: "x",
        deadline: null,
        constraints: [],
        confidence: 0.5,
        reason: "fake",
      }));
      return { items, provider: name, model: name, costUsd: 0, parseOk, finishReason };
    },
  };
}

async function scenario(tag, plan, hostileFrom) {
  const dataDir = mkdtempSync(path.join(root, `${tag}-`));
  const store = createStore({ dataDir });
  await seedMessages(store, 25);
  const ids = store.listMessages({ limit: 0 }).items.map((m) => m.id);
  const hostile = new Set(ids.slice(hostileFrom, hostileFrom + 10));
  const isHostile = (batch) => batch.some((m) => hostile.has(m.id));
  const provider = makeFake(`fake-${tag}`, (batch, callNo) => plan(batch, callNo, isHostile(batch)));
  const result = await runExtract({ env: { DATA_DIR: dataDir }, store, provider, batchSize: 10, concurrency: 1, retryDelayMs: 10 });
  return { store, result, provider, count: ids.length };
}

try {
  console.log(`临时 DATA_DIR 根: ${root}`);

  // ① 解析成功、但第 2 批 10 条里只给了 2 条 → 8 条 implicit negative，不重试
  const a = await scenario("implicit", (batch, callNo, hostile) => {
    const ids = batch.map((m) => m.id);
    return { ids: hostile ? ids.slice(0, 2) : ids, parseOk: true, finishReason: "stop" };
  }, 10);
  console.log("");
  console.log(`① parseOk=true 缺 8 条: modelCalls=${a.result.modelCalls} dropped=${a.result.droppedCount} implicit=${a.result.implicitNegatives} covered=${a.result.coveredCount}`);
  console.log(`   errors: ${JSON.stringify(a.result.errors)}`);
  check("① droppedCount = 0（没丢数据）", a.result.droppedCount === 0, `droppedCount=${a.result.droppedCount}`);
  check("① implicitNegatives = 8", a.result.implicitNegatives === 8, `实际 ${a.result.implicitNegatives}`);
  check("① modelCalls = 3（每批一次，完全不重试）", a.result.modelCalls === 3, `实际 ${a.result.modelCalls}`);
  check("① coveredCount = 17（25-8）", a.result.coveredCount === 17, `实际 ${a.result.coveredCount}`);
  check("① 全程没有重试/拆批日志", !a.result.errors.some((e) => e.includes("拆成") || e.includes("重试")), JSON.stringify(a.result.errors));

  // ② 解析失败（parseOk=false）→ 仍走重试/拆批/dropped
  const b = await scenario("parsefail", (batch, callNo, hostile) => {
    const ids = batch.map((m) => m.id);
    return { ids: hostile && ids.length >= 4 ? ids.slice(0, 1) : ids, parseOk: false, finishReason: null };
  }, 10);
  console.log("");
  console.log(`② parseOk=false: modelCalls=${b.result.modelCalls} dropped=${b.result.droppedCount} implicit=${b.result.implicitNegatives} covered=${b.result.coveredCount}`);
  console.log(`   errors: ${JSON.stringify(b.result.errors)}`);
  check("② droppedCount = 0（拆批救回）", b.result.droppedCount === 0, `droppedCount=${b.result.droppedCount}`);
  check("② implicitNegatives = 0（失败不算 implicit negative）", b.result.implicitNegatives === 0, `实际 ${b.result.implicitNegatives}`);
  check("② modelCalls > 3（确实重试/拆批过）", b.result.modelCalls > 3, `实际 ${b.result.modelCalls}`);
  check("② 有拆批日志", b.result.errors.some((e) => e.includes("拆成")), JSON.stringify(b.result.errors));

  // ③ 被截断（finish_reason=length，只给一半）→ 也走重试链，不算 implicit negative
  let lengthOnce = false;
  const c = await scenario("truncated", (batch, callNo, hostile) => {
    const ids = batch.map((m) => m.id);
    if (hostile && !lengthOnce) {
      lengthOnce = true;
      return { ids: ids.slice(0, Math.ceil(ids.length / 2)), parseOk: true, finishReason: "length" };
    }
    return { ids, parseOk: true, finishReason: "stop" };
  }, 10);
  console.log("");
  console.log(`③ finishReason=length: modelCalls=${c.result.modelCalls} dropped=${c.result.droppedCount} implicit=${c.result.implicitNegatives} covered=${c.result.coveredCount}`);
  console.log(`   errors: ${JSON.stringify(c.result.errors)}`);
  check("③ droppedCount = 0", c.result.droppedCount === 0, `droppedCount=${c.result.droppedCount}`);
  check("③ implicitNegatives = 0（截断不算 implicit negative）", c.result.implicitNegatives === 0, `实际 ${c.result.implicitNegatives}`);
  check("③ modelCalls > 3（截断触发了重试）", c.result.modelCalls > 3, `实际 ${c.result.modelCalls}`);
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log(`\n清理临时目录: ${root}`);
  if (failed) process.exitCode = 1;
}
