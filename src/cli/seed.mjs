#!/usr/bin/env node
// 只灌 mock 数据（演示 / 冒烟用），不触发抽取。
import { seedMessages, DEFAULT_TOTAL } from "../ingest/mock.js";
import { createStore } from "../store.js";
import { parseArgs, printKeyValues, resolveEnv } from "./args.js";

const args = parseArgs();
const env = resolveEnv(args);
const store = createStore({ dataDir: env.DATA_DIR });

const count = Number(args.mock) || DEFAULT_TOTAL;
const result = await seedMessages(store, count);

printKeyValues(`[seed] mock ${count} 条`, [
  ["导入", `${result.imported} 条`],
  ["跳过(重复)", `${result.skipped} 条`],
  ["runId", result.runId],
]);
