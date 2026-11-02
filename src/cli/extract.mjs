#!/usr/bin/env node
// 抽取：把库里的消息过一遍 LLM（默认 stub 规则），产出待办。
import { createProvider } from "../extract/provider.js";
import { runExtract } from "../extract/pipeline.js";
import { createStore } from "../store.js";
import { daysLeft } from "../shared/time.js";
import { parseArgs, printKeyValues, resolveEnv } from "./args.js";

const args = parseArgs();
const env = resolveEnv(args);
const store = createStore({ dataDir: env.DATA_DIR });

function dueLabel(deadline) {
  if (!deadline) return "无截止";
  const left = daysLeft(deadline);
  if (left === 0) return "今天到期";
  return left > 0 ? `${left} 天后到期` : `已逾期 ${-left} 天`;
}

if (args.help || args.h) {
  console.log("用法：node src/cli/extract.mjs [--limit N] [--group 群名] [--force] [--data-dir 目录]");
  process.exit(0);
}

const provider = createProvider(env);
const result = await runExtract({
  env,
  store,
  provider,
  limit: Number(args.limit) || 0,
  group: args.group ? String(args.group) : null,
  force: Boolean(args.force),
});

printKeyValues(`[extract] provider=${result.provider}`, [
  ["已处理", `${result.processed} 条消息`],
  ["新增待办", `${result.todosCreated} 条`],
  ["更新待办", `${result.todosUpdated} 条`],
  ["耗时", `${result.durationMs} ms`],
  ["成本", `$${result.costUsd.toFixed(6)}`],
  ["错误", `${result.errors.length} 个`],
  ["runId", result.runId],
]);

const { items } = store.listTodos({ status: "pending", limit: 5 });
if (items.length) {
  console.log("\n最近的待办（截止 / 标题）：");
  for (const todo of items) {
    console.log(`  ${todo.deadline || "—"}  ${dueLabel(todo.deadline)}  ${todo.title}${todo.constraints.length ? `  [${todo.constraints.join(" / ")}]` : ""}`);
  }
}
for (const error of result.errors.slice(0, 5)) console.log(`! ${error}`);
if (result.errors.length > 5) console.log(`……共 ${result.errors.length} 个错误`);
