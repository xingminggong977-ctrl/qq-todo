// 自测⑯：批量改状态（setTodoStatusMany）——UI 多选后一次落盘。
// 全程用临时 DATA_DIR，不碰真实数据目录。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-bulk-"));
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const statusOf = (store, id) => store.getTodo(id)?.status;
const byStatus = (store, status) => store.listTodos({ status, limit: 0 }).items.length;

try {
  const store = createStore({ dataDir });
  const seed = [0, 1, 2, 3, 4].map((i) => ({
    messageId: `m_bulk_${i}`,
    title: `批量用例 ${i}`,
    deadline: i < 3 ? `2026-10-1${i}` : null,
    reason: "自测",
    source: { groupName: "计科2201班级群", sender: "班长", ts: `2026-10-11T09:${String(10 + i).padStart(2, "0")}:00+08:00` },
  }));
  await store.addTodos(seed);
  const ids = store.listTodos({ status: "pending", limit: 0 }).items.map((t) => t.id);
  check("前置：5 条待办全部 pending", ids.length === 5, String(ids.length));

  // ① 批量 done
  const r1 = await store.setTodoStatusMany([ids[0], ids[1]], "done");
  check("① 批量 done 返回 {updated:2, skipped:0}", r1.updated === 2 && r1.skipped === 0, JSON.stringify(r1));
  check("① 两条真的变成 done", statusOf(store, ids[0]) === "done" && statusOf(store, ids[1]) === "done");
  check("① doneAt 被写上", Boolean(store.getTodo(ids[0]).doneAt), store.getTodo(ids[0]).doneAt);
  check("① 没被点到的仍是 pending", statusOf(store, ids[2]) === "pending");

  // ② 未知 id 进 skipped
  const r2 = await store.setTodoStatusMany([ids[2], "m_not_exist_1", "m_not_exist_2"], "done");
  check("② 未知 id 计入 skipped 且不抛", r2.updated === 1 && r2.skipped === 2, JSON.stringify(r2));
  check("② 存在的那个改了", statusOf(store, ids[2]) === "done");

  // ③ 非法 status 抛错且一条都不改
  const before = ids.map((id) => ({ ...store.getTodo(id) }));
  let err = null;
  try {
    await store.setTodoStatusMany([ids[3], ids[4]], "archived");
  } catch (e) {
    err = e;
  }
  check("③ 非法 status 抛 invalid_status", err?.message === "invalid_status", String(err?.message));
  const after = ids.map((id) => ({ ...store.getTodo(id) }));
  check(
    "③ 抛错后一条都没被改（status/updatedAt 全等）",
    before.every((t, i) => t.status === after[i].status && t.updatedAt === after[i].updatedAt),
    `${before.map((t) => t.status).join("/")} → ${after.map((t) => t.status).join("/")}`,
  );

  // ④ 批量 dismissed 后 pending 数量相符
  const pendingBefore = byStatus(store, "pending");
  const r4 = await store.setTodoStatusMany([ids[3], ids[4]], "dismissed");
  check("④ 批量 dismissed 返回 {updated:2, skipped:0}", r4.updated === 2 && r4.skipped === 0, JSON.stringify(r4));
  check("④ pending 数量少了 2", byStatus(store, "pending") === pendingBefore - 2, `${pendingBefore} → ${byStatus(store, "pending")}`);
  check("④ dismissed 数量为 2", byStatus(store, "dismissed") === 2, String(byStatus(store, "dismissed")));
  check("④ done 数量仍为 3", byStatus(store, "done") === 3, String(byStatus(store, "done")));
  check("④ 三种状态加起来等于总数", byStatus(store, "done") + byStatus(store, "dismissed") + byStatus(store, "pending") === 5);

  // ⑤ 与单条 setTodoStatus 混用，状态一致
  await store.setTodoStatus(ids[0], "pending");
  const mixed = [ids[0], ids[1], ids[2], ids[3], ids[4]].map((id) => statusOf(store, id));
  check("⑤ 混用后状态为 pending/done/done/dismissed/dismissed", mixed.join(",") === "pending,done,done,dismissed,dismissed", mixed.join(","));
  const stats = store.listTodos({ status: "all", limit: 0 }).stats;
  check("⑤ listTodos().stats 与逐条状态一致", stats.pending === 1 && stats.done === 2 && stats.dismissed === 2, JSON.stringify(stats));
  check("⑤ 重复 id 只算一次", (await store.setTodoStatusMany([ids[0], ids[0], ids[0]], "done")).updated === 1);
  check("⑤ 已经是目标状态算 skipped，不刷 updatedAt", JSON.stringify(await store.setTodoStatusMany([ids[0]], "done")) === JSON.stringify({ updated: 0, skipped: 1 }));
  check("⑤ 空数组返回 {updated:0, skipped:0}", JSON.stringify(await store.setTodoStatusMany([], "done")) === '{"updated":0,"skipped":0}');
  check("⑤ 单条 API 遇到未知状态仍然抛错（老行为没变）", await (async () => {
    try {
      await store.setTodoStatus(ids[0], "archived");
      return false;
    } catch {
      return true;
    }
  })());

  // 持久化：重启后状态还在
  const reopened = createStore({ dataDir });
  check("重启后批量结果仍在", statusOf(reopened, ids[1]) === "done" && statusOf(reopened, ids[3]) === "dismissed");

  console.log(fail === 0 ? `\nPASS=${pass} FAIL=0\n全部 PASS` : `\nPASS=${pass} FAIL=${fail}\n存在失败用例`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
