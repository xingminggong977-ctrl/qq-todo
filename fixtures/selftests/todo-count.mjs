// 自测①：stub 抽取 mock 220 条后 todo 数落在 20–120，且重跑不重复（幂等）。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { seedMessages } from "../../src/ingest/mock.js";
import { createProvider } from "../../src/extract/provider.js";
import { runExtract } from "../../src/extract/pipeline.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-count-"));
const env = { DATA_DIR: dataDir, LLM_PROVIDER: "stub" };
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const store = createStore({ dataDir });
  const seeded = await seedMessages(store, 220);
  console.log(`临时 DATA_DIR: ${dataDir}`);
  console.log(`mock 灌入: imported=${seeded.imported} skipped=${seeded.skipped}`);

  const provider = createProvider(env);
  const first = await runExtract({ env, store, provider });
  const todosAfterFirst = store.listTodos({}).items;
  console.log(
    `第 1 次抽取: processed=${first.processed} todosCreated=${first.todosCreated} errors=${first.errors.length} costUsd=${first.costUsd} ${first.durationMs}ms`
  );
  console.log(`库内 todo 数(第 1 次后) = ${todosAfterFirst.length}`);

  const second = await runExtract({ env, store, provider, force: true });
  const todosAfterSecond = store.listTodos({}).items;
  console.log(`第 2 次抽取(force 全量重跑): processed=${second.processed} todosCreated=${second.todosCreated} todosUpdated=${second.todosUpdated}`);
  console.log(`库内 todo 数(第 2 次后) = ${todosAfterSecond.length}`);

  const ids = new Set(todosAfterSecond.map((t) => t.id));
  const messageIds = todosAfterSecond.map((t) => t.messageId);
  const uniqueByMessage = new Set(messageIds).size;

  console.log("");
  check("todo 数在 20–120 之间", todosAfterFirst.length >= 20 && todosAfterFirst.length <= 120, `实际 ${todosAfterFirst.length}`);
  check("第 2 次确认没有新增", second.todosCreated === 0, `todosCreated=${second.todosCreated}`);
  check("第 2 次后总数不变", todosAfterSecond.length === todosAfterFirst.length, `${todosAfterFirst.length} -> ${todosAfterSecond.length}`);
  check("todo id 无重复", ids.size === todosAfterSecond.length);
  check("每条 todo 的 messageId 唯一（按 messageId 幂等）", uniqueByMessage === todosAfterSecond.length, `${uniqueByMessage}/${todosAfterSecond.length}`);
  check("消息库未被重复灌入", store.listMessages({ limit: 0 }).total === 220, `messages=${store.listMessages({ limit: 0 }).total}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n清理临时目录: ${dataDir}`);
  if (failed) process.exitCode = 1;
}
