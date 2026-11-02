// 自测③：至少一条 todo 的 constraints.length >= 2，并列出分布。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { seedMessages } from "../../src/ingest/mock.js";
import { createStubProvider } from "../../src/extract/provider.js";
import { runExtract } from "../../src/extract/pipeline.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-constraints-"));
const env = { DATA_DIR: dataDir, LLM_PROVIDER: "stub" };
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const store = createStore({ dataDir });
  await seedMessages(store, 220);
  await runExtract({ env, store, provider: createStubProvider() });

  const todos = store.listTodos({}).items;
  const multi = todos.filter((t) => Array.isArray(t.constraints) && t.constraints.length >= 2);
  const dist = {};
  for (const todo of todos) dist[todo.constraints.length] = (dist[todo.constraints.length] || 0) + 1;

  console.log(`todo 总数 = ${todos.length}`);
  console.log("constraints 条数分布 (长度 → todo 数) =", JSON.stringify(dist));
  console.log(`constraints.length >= 2 的 todo 数 = ${multi.length}\n`);
  console.log("示例（前 6 条，硬约束 ≥2 的行首标 *）：");
  for (const todo of todos.slice(0, 12)) {
    const star = todo.constraints.length >= 2 ? "*" : " ";
    console.log(`${star} [${todo.constraints.join(" | ") || "—"}]  ${todo.title}`);
  }

  console.log("");
  check("至少 1 条 todo 的 constraints.length >= 2", multi.length >= 1, `实际 ${multi.length} 条`);
  for (const todo of multi.slice(0, 3)) {
    console.log(`    · ${todo.title} -> ${JSON.stringify(todo.constraints)}`);
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n清理临时目录: ${dataDir}`);
  if (failed) process.exitCode = 1;
}
