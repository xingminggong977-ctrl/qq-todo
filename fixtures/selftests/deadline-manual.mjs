// 自测：手动设/清截止日（store.setTodoDeadline + PATCH {deadline}）。
// 群里没写日期的待办，用户可以自己补一个，补完才会进 dueSoon / 到期提醒 / 日历订阅。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-deadline-manual-"));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const baseTodo = (over = {}) => ({
  messageId: over.messageId ?? "m_manual_1",
  title: over.title ?? "交实践报告",
  deadline: over.deadline === undefined ? null : over.deadline,
  deadlineText: null,
  constraints: [],
  confidence: 0.7,
  reason: "有交付物",
  source: { groupName: "示例班级群", sender: "班长", ts: "2026-11-01T09:00:00+08:00" },
  model: "rules-v1",
});

try {
  const store = createStore({ dataDir });
  await store.addTodos([baseTodo({ messageId: "m_manual_1", title: "交实践报告" })]);
  await store.addTodos([baseTodo({ messageId: "m_manual_2", title: "找导师签字", deadline: "2026-11-20" })]);
  const pending = (await store.listTodos({ status: "pending" })).items;
  check("初始两条都在", pending.length === 2, `length=${pending.length}`);
  const noDeadline = pending.find((t) => t.title === "交实践报告");
  const hasDeadline = pending.find((t) => t.title === "找导师签字");
  check("第一条本来没有截止日", !noDeadline.deadline, `deadline=${noDeadline.deadline}`);

  // 1) 设日期
  const set = await store.setTodoDeadline(noDeadline.id, "2026-11-15");
  check("设日期返回新值", set?.deadline === "2026-11-15", `deadline=${set?.deadline}`);
  check("标记为手动填的", set?.deadlineManual === true, `deadlineManual=${set?.deadlineManual}`);
  // updatedAt 只到秒，同秒内改两次看不出差；这里断言「不比原来早」而不是「必须变」
  check("updatedAt 不早于原值", String(set?.updatedAt) >= String(noDeadline.updatedAt), `${noDeadline.updatedAt} → ${set?.updatedAt}`);
  check("状态没被改动", set?.status === "pending", `status=${set?.status}`);

  // 2) 落盘后重开仍在
  const reopened = createStore({ dataDir });
  const after = (await reopened.listTodos({ status: "pending" })).items.find((t) => t.id === noDeadline.id);
  check("重开 store 后日期还在", after?.deadline === "2026-11-15", `deadline=${after?.deadline}`);

  // 3) 进不进 dueSoon：14 天窗口内应该能看到
  const stats = await reopened.getStats();
  const dueTitles = (stats.dueSoon || []).map((t) => t.title);
  check("手动日期进了 dueSoon", dueTitles.includes("交实践报告"), `dueSoon=${JSON.stringify(dueTitles)}`);

  // 4) 非法格式被拒，且不改原值
  let threw = false;
  try {
    await reopened.setTodoDeadline(noDeadline.id, "2026/11/15");
  } catch (err) {
    threw = String(err?.message || err).includes("invalid_deadline");
  }
  check("非法格式抛 invalid_deadline", threw);
  const still = await reopened.getTodo(noDeadline.id);
  check("非法写入没改动原值", still?.deadline === "2026-11-15", `deadline=${still?.deadline}`);

  // 5) 清空
  const cleared = await reopened.setTodoDeadline(noDeadline.id, null);
  check("清空后为 null", cleared?.deadline === null, `deadline=${cleared?.deadline}`);
  check("清空后手动标记归零", cleared?.deadlineManual === false, `deadlineManual=${cleared?.deadlineManual}`);
  const stats2 = await reopened.getStats();
  const dueTitles2 = (stats2.dueSoon || []).map((t) => t.title);
  check("清空后退出 dueSoon", !dueTitles2.includes("交实践报告"), `dueSoon=${JSON.stringify(dueTitles2)}`);

  // 6) 手动改已有日期（覆盖模型给的）
  const overwrite = await reopened.setTodoDeadline(hasDeadline.id, "2026-12-01");
  check("可以覆盖模型给的日期", overwrite?.deadline === "2026-12-01", `deadline=${overwrite?.deadline}`);
  check("覆盖时保留原文里的写法", overwrite?.deadlineText === null || overwrite?.deadlineText === undefined, `deadlineText=${overwrite?.deadlineText}`);

  // 7) 不存在的 id 返回 null，不抛
  const missing = await reopened.setTodoDeadline("t_不存在", "2026-11-15");
  check("未知 id 返回 null", missing === null, `ret=${missing}`);

  // 8) 空串等价于清空
  const empty = await reopened.setTodoDeadline(hasDeadline.id, "");
  check("空串等价清空", empty?.deadline === null, `deadline=${empty?.deadline}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? "RESULT FAIL" : "RESULT PASS");
process.exit(failed ? 1 : 0);
