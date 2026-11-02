// 自测⑧：跨群同通知去重（duplicates）+ 待办推后（snoozedUntil）。
// 全程用临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-dedupe-"));
const legacyDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-legacy-"));
const laterDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-snooze-now-"));
const crossDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-crossdone-"));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const todo = (over = {}) => ({
  messageId: over.messageId,
  title: over.title ?? "提交实践报告",
  deadline: over.deadline === undefined ? "2026-10-16" : over.deadline,
  deadlineText: "本周五前",
  constraints: ["学习通", "PDF"],
  confidence: 0.8,
  reason: "有截止时间",
  source: { groupName: over.groupName ?? "计科2201班级群", sender: "辅导员", ts: over.ts ?? "2026-10-11T09:20:00+08:00" },
  model: "rules-v1",
});

try {
  console.log(`临时 DATA_DIR: ${dataDir}`);
  const store = createStore({ dataDir });

  // ① 同标题同截止、不同群、灌两次 → 只留 1 条，duplicates 记第二个群
  await store.addTodos([
    todo({ messageId: "m_aaa", groupName: "计科2201班级群" }),
    todo({ messageId: "m_bbb", groupName: "示例年级群", ts: "2026-10-11T10:30:00+08:00" }),
  ]);
  let list = store.listTodos({ status: "pending" }).items;
  console.log(`① todos=${list.length} duplicates=${JSON.stringify(list[0]?.duplicates)}`);
  check("① 只有 1 条待办", list.length === 1, `实际 ${list.length}`);
  check("① duplicates.length = 1", list[0]?.duplicates?.length === 1, `实际 ${list[0]?.duplicates?.length}`);
  check("① duplicates 记的是第二个群", list[0]?.duplicates?.[0]?.groupName === "示例年级群", list[0]?.duplicates?.[0]?.groupName);
  check("① duplicates.at 用消息时间", list[0]?.duplicates?.[0]?.at === "2026-10-11T10:30:00+08:00", list[0]?.duplicates?.[0]?.at);
  check("① source 仍是最初那个群", list[0]?.source?.groupName === "计科2201班级群", list[0]?.source?.groupName);
  check("① source.ts 未被覆盖", list[0]?.source?.ts === "2026-10-11T09:20:00+08:00", list[0]?.source?.ts);

  // ①b 同群再发一次 → 走原有「撞 pending 合并」，不产生 duplicate 条目
  const beforeDup = list[0].duplicates.length;
  await store.addTodos([todo({ messageId: "m_ccc", groupName: "计科2201班级群", ts: "2026-10-11T11:00:00+08:00" })]);
  list = store.listTodos({ status: "pending" }).items;
  check("①b 同群重复仍只 1 条", list.length === 1, `实际 ${list.length}`);
  check("①b 同群合并不加 duplicates", list[0]?.duplicates?.length === beforeDup, `实际 ${list[0]?.duplicates?.length}`);

  // ①c 同群重新发第三次（另一个群名）→ 同一 groupName 只保留最新一条
  await store.addTodos([todo({ messageId: "m_ddd", groupName: "示例年级群", ts: "2026-10-11T12:00:00+08:00" })]);
  list = store.listTodos({ status: "pending" }).items;
  check("①c 换群再发仍 1 条", list.length === 1, `实际 ${list.length}`);
  check("①c 同群只保留最新（len 仍 1）", list[0]?.duplicates?.length === 1, `实际 ${list[0]?.duplicates?.length}`);
  check("①c duplicates.at 取最新那条", list[0]?.duplicates?.[0]?.at === "2026-10-11T12:00:00+08:00", list[0]?.duplicates?.[0]?.at);

  // ①d duplicates 上限 5
  for (let i = 0; i < 7; i += 1) {
    await store.addTodos([todo({ messageId: `m_cap${i}`, groupName: `第${i}个转发群`, ts: `2026-10-11T1${i}:30:00+08:00` })]);
  }
  list = store.listTodos({ status: "pending" }).items;
  console.log(`①d duplicates=${JSON.stringify(list[0]?.duplicates.map((d) => d.groupName))}`);
  check("①d duplicates 上限 5", list[0]?.duplicates?.length === 5, `实际 ${list[0]?.duplicates?.length}`);
  check("①d 丢的是最老的（留下最后 5 个群）", list[0]?.duplicates?.[4]?.groupName === "第6个转发群", list[0]?.duplicates?.[4]?.groupName);

  // ② 同标题但 deadline 不同 → 两件事，必须 2 条
  const before = store.listTodos({ status: "pending" }).items.length;
  await store.addTodos([todo({ messageId: "m_eee", groupName: "示例学院学生会", deadline: "2026-10-20" })]);
  list = store.listTodos({ status: "pending" }).items;
  console.log(`② todos=${list.length} deadlines=${JSON.stringify(list.map((t) => t.deadline))}`);
  check("② deadline 不同则新建（+1 条）", list.length === before + 1, `${before} → ${list.length}`);
  check("② 新行 deadline = 2026-10-20", list.some((t) => t.deadline === "2026-10-20"), JSON.stringify(list.map((t) => t.deadline)));

  // ③ snooze：设到明天 → counts.snoozed=1，且 pending 列表里排最后
  const target = list.find((t) => t.deadline === "2026-10-16");
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const snoozed = await store.snoozeTodo(target.id, tomorrow);
  const counts = store.counts();
  const pending = store.listTodos({ status: "pending" }).items;
  console.log(`③ snoozedUntil=${snoozed.snoozedUntil} counts.snoozed=${counts.snoozed} 顺序=${JSON.stringify(pending.map((t) => t.title + (t.snoozedUntil ? "(snoozed)" : "")))}`);
  check("③ snoozedUntil 已写入", Boolean(snoozed.snoozedUntil), String(snoozed.snoozedUntil));
  check("③ updatedAt 未倒退", Date.parse(snoozed.updatedAt) >= Date.parse(target.updatedAt), `${target.updatedAt} → ${snoozed.updatedAt}`);
  check("③ stats().counts.snoozed = 1", store.stats().counts.snoozed === 1, `实际 ${store.stats().counts.snoozed}`);
  check("③ pending 列表默认包含 snoozed 项", pending.length === list.length, `${list.length} → ${pending.length}`);
  check("③ snoozed 排在最后", pending[pending.length - 1]?.id === target.id, pending[pending.length - 1]?.title);
  const dueSoon = store.getStats().dueSoon;
  console.log(`③d dueSoon=${JSON.stringify(dueSoon.map((t) => t.title + "/" + t.deadline))}`);
  check("③d snoozed 项不出现在 dueSoon", !dueSoon.some((t) => t.id === target.id), dueSoon.map((t) => t.title).join(","));
  check("③d 未推后的到期项仍在 dueSoon", dueSoon.some((t) => t.deadline === "2026-10-20"), JSON.stringify(dueSoon.map((t) => t.deadline)));

  // ③b 到期后自动不再算 snoozed（注入 now）
  const clock = { t: Date.parse("2026-11-01T09:00:00+08:00") };
  const timed = createStore({ dataDir: laterDir, now: () => clock.t });
  await timed.addTodos([todo({ messageId: "m_ttt", groupName: "计时测试群" })]);
  const beforeSnooze = timed.listTodos({ status: "pending" }).items[0];
  const idT = beforeSnooze.id;
  clock.t = Date.parse("2026-11-01T10:00:00+08:00");
  const timedSnoozed = await timed.snoozeTodo(idT, "2026-11-02");
  check("③b updatedAt 被刷新（注入时钟前进 1 小时）", timedSnoozed.updatedAt !== beforeSnooze.updatedAt, `${beforeSnooze.updatedAt} → ${timedSnoozed.updatedAt}`);
  check("③b 推后到 11-02 → 11-01 时算 snoozed", timed.counts().snoozed === 1, `实际 ${timed.counts().snoozed}`);
  clock.t = Date.parse("2026-11-03T09:00:00+08:00");
  check("③b 到了 11-03 自动不再算 snoozed", timed.counts().snoozed === 0, `实际 ${timed.counts().snoozed}`);
  check("③b 过期 snoozed 项回到正常排序位置", timed.listTodos({ status: "pending" }).items[0].id === idT, "ok");

  // ③c 非法日期
  let threw = null;
  try {
    await store.snoozeTodo(target.id, "不是日期");
  } catch (err) {
    threw = err;
  }
  check("③c 非法日期抛 invalid_snooze", threw?.message === "invalid_snooze", String(threw?.message));
  const cleared = await store.snoozeTodo(target.id, null);
  check("③c 传 null 可取消推后", cleared.snoozedUntil === null, String(cleared.snoozedUntil));

  // ①e 重启后 duplicates 还在、且同一条消息重放不再新建
  await store.flush();
  const reloaded = createStore({ dataDir });
  const afterReload = reloaded.listTodos({ status: "pending" }).items;
  check("①e 重开 store 后 duplicates 仍在", afterReload.some((t) => t.duplicates.length === 5), JSON.stringify(afterReload.map((t) => t.duplicates.length)));
  const beforeReplay = afterReload.length;
  await reloaded.addTodos([todo({ messageId: "m_bbb", groupName: "示例年级群" })]);
  check("①e 重放同一条消息不新增（幂等）", reloaded.listTodos({ status: "pending" }).items.length === beforeReplay, `${beforeReplay} → ${reloaded.listTodos({ status: "pending" }).items.length}`);

  // ④ 老格式 store.json（无 duplicates / snoozedUntil）能读、不抛错
  const legacy = {
    version: 1,
    messages: [{ id: "m_old", groupName: "老群", sender: "老王", ts: "2026-10-01T08:00:00+08:00", text: "老消息", kind: "text", noise: false }],
    todos: [
      {
        id: "t_old",
        messageId: "m_old",
        title: "老台账",
        deadline: "2026-10-10",
        constraints: [],
        confidence: 0.9,
        reason: "",
        status: "pending",
        source: { groupName: "老群", sender: "老王", ts: "2026-10-01T08:00:00+08:00" },
        model: "rules-v1",
        createdAt: "2026-10-01T08:00:00+08:00",
        updatedAt: "2026-10-01T08:00:00+08:00",
        doneAt: null,
        dismissedAt: null,
      },
    ],
    runs: [],
    corrections: [],
  };
  writeFileSync(path.join(legacyDir, "store.json"), JSON.stringify(legacy));
  let legacyStore = null;
  let legacyErr = null;
  try {
    legacyStore = createStore({ dataDir: legacyDir });
    const items = legacyStore.listTodos({ status: "pending" }).items;
    console.log(`④ legacy todos=${items.length} duplicates=${JSON.stringify(items[0]?.duplicates)} snoozedUntil=${String(items[0]?.snoozedUntil)}`);
    check("④ 老格式能读、待办数不变", items.length === 1, `实际 ${items.length}`);
    check("④ 补出 duplicates: []", Array.isArray(items[0]?.duplicates) && items[0].duplicates.length === 0, JSON.stringify(items[0]?.duplicates));
    check("④ 补出 snoozedUntil: null", items[0]?.snoozedUntil === null, String(items[0]?.snoozedUntil));
    check("④ counts.snoozed = 0", legacyStore.counts().snoozed === 0, `实际 ${legacyStore.counts().snoozed}`);
    await legacyStore.snoozeTodo("t_old", "2026-12-01");
    check("④ 老数据也能推后", legacyStore.getTodo("t_old").snoozedUntil === "2026-12-01", String(legacyStore.getTodo("t_old").snoozedUntil));
    await legacyStore.flush();
    const written = JSON.parse(readFileSync(path.join(legacyDir, "store.json"), "utf8"));
    check("④ 写回后文件里有 duplicates/snoozedUntil", Array.isArray(written.todos[0].duplicates) && "snoozedUntil" in written.todos[0], JSON.stringify(Object.keys(written.todos[0])));
  } catch (err) {
    legacyErr = err;
  }
  check("④ 老格式读取全程不抛错", legacyErr === null, String(legacyErr?.message));

  // ①f 原行已 done 时，另一群转发不许被旧行吸收 → 新建 pending 行且 duplicates 为空
  const crossStore = createStore({ dataDir: crossDir });
  await crossStore.addTodos([todo({ messageId: "m_done1", groupName: "计科2201班级群" })]);
  const firstRow = crossStore.listTodos({ status: "pending" }).items[0];
  await crossStore.setTodoStatus(firstRow.id, "done");
  await crossStore.addTodos([todo({ messageId: "m_done2", groupName: "示例年级群", ts: "2026-10-11T15:00:00+08:00" })]);
  const crossPending = crossStore.listTodos({ status: "pending" }).items;
  const doneRow = crossStore.getTodo(firstRow.id);
  console.log(`①f pending=${crossPending.length} doneRow.duplicates=${JSON.stringify(doneRow.duplicates)} newRow.duplicates=${JSON.stringify(crossPending[0]?.duplicates)}`);
  check("①f done 行不被吸收（duplicates 仍为空）", doneRow.duplicates.length === 0, JSON.stringify(doneRow.duplicates));
  check("①f done 行状态仍是 done", doneRow.status === "done", doneRow.status);
  check("①f 新群里转发会新建 1 条 pending", crossPending.length === 1, `实际 ${crossPending.length}`);
  check("①f 新行 duplicates 为空", crossPending[0]?.duplicates?.length === 0, JSON.stringify(crossPending[0]?.duplicates));
  check("①f 新行 source 是后一个群", crossPending[0]?.source?.groupName === "示例年级群", crossPending[0]?.source?.groupName);

  console.log(failed ? "\n存在失败用例" : "\n全部 PASS");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
  rmSync(laterDir, { recursive: true, force: true });
  rmSync(crossDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
