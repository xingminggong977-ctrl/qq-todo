#!/usr/bin/env node
// 导入：QQ 导出 txt（--file）或内置 mock（--mock N）。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createStore } from "../store.js";
import { generateMockMessages } from "../ingest/mock.js";
import { parseQqExport } from "../ingest/parser.js";
import { parseArgs, printKeyValues, resolveEnv } from "./args.js";

const args = parseArgs();
const env = resolveEnv(args);
const store = createStore({ dataDir: env.DATA_DIR });

if (args.help || args.h) {
  console.log("用法：node src/cli/import.mjs --file <qq导出.txt> [--group 群名] [--data-dir 目录]");
  console.log("      node src/cli/import.mjs --mock 220 [--data-dir 目录]");
  process.exit(0);
}

const startedAt = new Date().toISOString();

if (args.mock) {
  const count = Number(args.mock) || 220;
  const messages = generateMockMessages(count);
  const result = await store.addMessages(messages);
  await store.addRun({ kind: "ingest", startedAt, provider: "mock", imported: result.imported, skipped: result.skipped });
  const groups = [...new Set(messages.map((m) => m.groupName))];
  printKeyValues(`[import] mock ${count} 条（种子固定，可复现）`, [
    ["群", groups.join("、")],
    ["导入", `${result.imported} 条`],
    ["跳过(重复)", `${result.skipped} 条`],
    ["未识别", "0 行"],
    ["库内", `${store.listMessages({ limit: 0 }).total} 条消息 / ${store.listTodos({}).items.length} 条待办`],
  ]);
  process.exit(0);
}

if (!args.file) {
  console.log("缺少参数：--file <path> 或 --mock <N>（--help 看用法）");
  process.exit(1);
}

const filePath = path.resolve(process.cwd(), String(args.file));
if (!existsSync(filePath)) {
  console.error(`文件不存在：${filePath}`);
  process.exit(1);
}

const content = readFileSync(filePath, "utf8");
const parsed = parseQqExport(path.basename(filePath), content, { groupName: args.group ? String(args.group) : "" });
const result = await store.addMessages(parsed.messages);
await store.addRun({ kind: "ingest", startedAt, provider: "file", imported: result.imported, skipped: result.skipped });

printKeyValues(`[import] ${filePath}`, [
  ["格式", parsed.format],
  ["群", `${parsed.groups.join("、") || "（未识别）"}（${parsed.messages.length} 条）`],
  ["导入", `${result.imported} 条`],
  ["跳过(重复)", `${result.skipped} 条`],
  ["未识别", `${parsed.unrecognized.length} 行`],
  ["库内", `${store.listMessages({ limit: 0 }).total} 条消息 / ${store.listTodos({}).items.length} 条待办`],
]);

if (parsed.unrecognized.length) {
  console.log("\n未识别行（前 5 条）：");
  for (const item of parsed.unrecognized.slice(0, 5)) console.log(`  第${item.line}行  ${item.sample}`);
  if (parsed.unrecognized.length > 5) console.log(`  ……共 ${parsed.unrecognized.length} 行`);
}
for (const warning of parsed.warnings) console.log(`! ${warning}`);
