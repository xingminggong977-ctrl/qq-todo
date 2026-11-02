// 自测②：消息时间 2026-10-11 + 原文「10月12日24点」→ deadline 2026-10-12。
// 同时验证落库后的 todo.deadline 一致。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { makeMessageId } from "../../src/shared/message.js";
import { createStubProvider, extractDeadline } from "../../src/extract/provider.js";
import { runExtract } from "../../src/extract/pipeline.js";

const TS = "2026-10-11T12:11:05+08:00";
const TEXT = "作业提交截止10月12日24点，逾期系统关闭，请各班学委统计未交名单";
const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-deadline-"));
const env = { DATA_DIR: dataDir, LLM_PROVIDER: "stub" };
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const direct = extractDeadline(TEXT, TS);
  console.log(`extractDeadline("${TEXT}", ${TS}) =>`, JSON.stringify(direct));

  const message = {
    id: makeMessageId("示例班级群", TS, "罗雨(123456)", TEXT),
    groupName: "示例班级群",
    sender: "罗雨(123456)",
    ts: TS,
    text: TEXT,
    kind: "text",
  };
  const batch = await createStubProvider().classify([message]);
  const item = batch.items[0];
  console.log("stub.items[0] =", JSON.stringify(item));

  const store = createStore({ dataDir });
  await store.addMessages([message]);
  const run = await runExtract({ env, store, provider: createStubProvider() });
  const todos = store.listTodos({}).items;
  console.log(`落库: messages=${store.listMessages({ limit: 0 }).total} todos=${todos.length} processed=${run.processed}`);
  for (const todo of todos) {
    console.log("  todo:", JSON.stringify({ id: todo.id, messageId: todo.messageId, title: todo.title, deadline: todo.deadline, owner: todo.owner }));
  }

  console.log("");
  check("extractDeadline 直接解析出 2026-10-12", direct && direct.deadline === "2026-10-12", String(direct && direct.deadline));
  check("stub 判定为待办（item.todo 为 true）", item.todo === true, String(item.todo));
  check("stub item.deadline = 2026-10-12", item.deadline === "2026-10-12", String(item.deadline));
  check("落库 todo.deadline = 2026-10-12", todos.length === 1 && todos[0].deadline === "2026-10-12", String(todos[0] && todos[0].deadline));
  check("落库 todo.messageId 指向原消息", todos.length === 1 && todos[0].messageId === message.id, String(todos[0] && todos[0].messageId));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n清理临时目录: ${dataDir}`);
  if (failed) process.exitCode = 1;
}
