// 自测⑫：附件正文接入判定链路（pipeline 集成）。
// 用内存假 store（只实现 pipeline 需要的四个方法），因为 store.normalizeMessage 不保留 attachmentFile。
import path from "node:path";
import { runExtract } from "../../src/extract/pipeline.js";
import { createStubProvider } from "../../src/extract/provider.js";

const PDF = path.resolve("fixtures/attachments/sample.pdf");
const TXT = path.resolve("fixtures/attachments/sample.txt");
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

function makeStore(messages) {
  const todos = [];
  const runs = [];
  return {
    messages,
    todos,
    runs,
    listMessages({ limit = 100, group = "", noise } = {}) {
      let items = messages.slice();
      if (group) items = items.filter((m) => m.groupName === group);
      if (noise === "exclude" || noise === false) items = items.filter((m) => !m.noise);
      const sorted = items.slice().sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1));
      const max = Number(limit) > 0 ? Number(limit) : sorted.length;
      return { items: sorted.slice(0, max), total: items.length, groups: [...new Set(messages.map((m) => m.groupName))] };
    },
    listTodos() {
      return { items: todos.slice(), stats: {} };
    },
    async addTodos(list) {
      let created = 0;
      for (const todo of Array.isArray(list) ? list : [list]) {
        if (todos.some((t) => t.messageId === todo.messageId)) continue;
        todos.push({ id: `t_${todos.length + 1}`, ...todo });
        created += 1;
      }
      return { created, updated: 0, skipped: 0 };
    },
    async addRun(run) {
      runs.push({ id: `r_${runs.length + 1}`, ...run });
      return runs[runs.length - 1];
    },
    getStats() {
      return { counts: { todos: todos.length } };
    },
  };
}

const message = (over = {}) => ({
  id: over.id,
  groupName: "示例年级群",
  sender: "辅导员罗雨",
  ts: over.ts ?? "2026-10-11T09:20:00+08:00",
  text: over.text ?? "",
  kind: over.attachment ? "file" : "text",
  noise: false,
  attachment: over.attachment ?? null,
  ...(over.attachmentFile ? { attachmentFile: over.attachmentFile } : {}),
});

const withAttachments = [
  message({
    id: "m_pdf",
    ts: "2026-10-11T09:20:00+08:00",
    text: "见附件6《体测安全风险告知书》，各班级按要求组织填写。",
    attachment: { name: "附件6-体测安全风险告知书.pdf", size: 49157 },
    attachmentFile: PDF,
  }),
  message({
    id: "m_txt",
    ts: "2026-10-11T09:21:00+08:00",
    text: "补充说明见附件。",
    attachment: { name: "补充说明.txt", size: 155 },
    attachmentFile: TXT,
  }),
  message({ id: "m_plain", ts: "2026-10-11T09:22:00+08:00", text: "明天下午三点在西楼117开会，请准时到。" }),
  message({
    id: "m_broken",
    ts: "2026-10-11T09:23:00+08:00",
    text: "附件在群文件里，自己下。",
    attachment: { name: "不存在.pdf", size: 1 },
    attachmentFile: path.resolve("fixtures/attachments/definitely-missing.pdf"),
  }),
];

const seen = [];
const inner = createStubProvider();
const spy = {
  name: inner.name,
  kind: inner.kind,
  model: inner.model,
  usage: inner.usage,
  stats: inner.stats,
  async classify(batch, ctx) {
    for (const m of batch) seen.push({ id: m.id, text: m.text });
    return inner.classify(batch, ctx);
  },
};

const store = makeStore(withAttachments);
const run = await runExtract({ env: {}, store, provider: spy, batchSize: 24, concurrency: 1 });
const textOf = (id) => seen.find((s) => s.id === id)?.text ?? "";
console.log(`pdf 送模型文本=${JSON.stringify(textOf("m_pdf").slice(0, 40))}… 含标记=${textOf("m_pdf").includes("【附件正文】")}`);
console.log(`txt 送模型文本=${JSON.stringify(textOf("m_txt").slice(0, 40))}… 含标记=${textOf("m_txt").includes("【附件正文】")}`);
console.log(`plain 送模型文本=${JSON.stringify(textOf("m_plain"))}`);

check("带 pdf 的送模型文本含【附件正文】", textOf("m_pdf").includes("【附件正文】"), "ok");
check("带 pdf 的送模型文本含「10月12日」", textOf("m_pdf").includes("10月12日"), "ok");
check("带 pdf 的送模型文本含「陈倩」", textOf("m_pdf").includes("陈倩"), "ok");
check("原文仍在附件正文之前", textOf("m_pdf").startsWith("见附件6《体测安全风险告知书》"), "ok");
check("带 txt 的送模型文本含附件正文", textOf("m_txt").includes("【附件正文】") && textOf("m_txt").includes("不漏一人"), "ok");
check("无附件的消息文本原样不动", textOf("m_plain") === "明天下午三点在西楼117开会，请准时到。", textOf("m_plain"));
check("附件文件缺失时按原文判定", textOf("m_broken") === "附件在群文件里，自己下。", textOf("m_broken"));
check("附件失败不产生 dropped", run.droppedCount === 0, String(run.droppedCount));
check("附件失败不产生 error 条目", run.errors.length === 0, JSON.stringify(run.errors));
check("每条消息仍各有一条决策", run.decisions.length === withAttachments.length, `${run.decisions.length}/${withAttachments.length}`);
check("库里的原文没有被改写", store.messages.every((m) => !m.text.includes("【附件正文】")), "ok");
check("store 里的 attachmentFile 仍在（未被我改动）", store.messages.filter((m) => m.attachmentFile).length === 3, "ok");

// 对照 A：同样三条消息但完全不带附件 → 待办数会变（因为模型现在**看得见**「截止时间：10月12日」），
// 但决策条数、dropped/implicit 口径、消息数必须一模一样。
const plainStore = makeStore(withAttachments.map(({ attachmentFile, attachment, ...rest }) => ({ ...rest, attachment: null, kind: "text" })));
const plainRun = await runExtract({ env: {}, store: plainStore, provider: createStubProvider(), batchSize: 24, concurrency: 1 });
console.log(`带附件 todos=${run.todosCreated} decisions=${run.decisions.length} | 不带附件 todos=${plainRun.todosCreated} decisions=${plainRun.decisions.length}`);
check("附件不改变决策条数", run.decisions.length === plainRun.decisions.length, `${run.decisions.length} vs ${plainRun.decisions.length}`);
check("附件不改变 dropped/implicit 口径", run.droppedCount === plainRun.droppedCount && run.implicitNegatives === plainRun.implicitNegatives, `${run.droppedCount}/${run.implicitNegatives}`);
console.log(`注：待办数 ${plainRun.todosCreated} → ${run.todosCreated} 是附件正文带来的**真实**判定差（stub 从 PDF 里读到「截止时间：10月12日」），正是本次要的能力，不是口径漂移`);

// 对照 B：无附件文件、但文本里已手工拼好同样的附件正文 → 待办数必须与带附件完全一致（证明拼装链路无损）
const mirror = withAttachments.map((m) => {
  const { attachmentFile, attachment, ...rest } = m;
  const enriched = seen.find((s) => s.id === m.id)?.text ?? m.text;
  return { ...rest, text: enriched, attachment: null, kind: "text" };
});
const mirrorStore = makeStore(mirror);
const mirrorRun = await runExtract({ env: {}, store: mirrorStore, provider: createStubProvider(), batchSize: 24, concurrency: 1 });
console.log(`手工拼好同样正文 todos=${mirrorRun.todosCreated} decisions=${mirrorRun.decisions.length} | 走附件链路 todos=${run.todosCreated} decisions=${run.decisions.length}`);
check("拼装链路无损：与手工拼好同样正文的待办数一致", mirrorRun.todosCreated === run.todosCreated, `${mirrorRun.todosCreated} vs ${run.todosCreated}`);
check("拼装链路无损：决策条数一致", mirrorRun.decisions.length === run.decisions.length, `${mirrorRun.decisions.length} vs ${run.decisions.length}`);

// 同一路径在一轮里只解析一次：两个消息共享 PDF，缓存后两条都应拿到正文
const sharedStore = makeStore([
  message({ id: "m_s1", ts: "2026-10-11T09:20:00+08:00", text: "见附件。", attachment: { name: "a.pdf", size: 1 }, attachmentFile: PDF }),
  message({ id: "m_s2", ts: "2026-10-11T09:21:00+08:00", text: "同上附件。", attachment: { name: "a.pdf", size: 1 }, attachmentFile: PDF }),
]);
const sharedSeen = [];
const sharedSpy = {
  name: "stub",
  kind: "stub",
  model: "rules-v1",
  async classify(batch, ctx) {
    for (const m of batch) sharedSeen.push(m.text);
    return inner.classify(batch, ctx);
  },
};
const sharedRun = await runExtract({ env: {}, store: sharedStore, provider: sharedSpy, batchSize: 24, concurrency: 1 });
console.log(`共享路径两条都含标记=${sharedSeen.filter((t) => t.includes("【附件正文】")).length}`);
check("同一路径的两条消息都拿到附件正文（Map 缓存）", sharedSeen.filter((t) => t.includes("【附件正文】")).length === 2, `${sharedSeen.length}`);
check("共享路径不产生重复错误", sharedRun.errors.length === 0, JSON.stringify(sharedRun.errors));

console.log(failed ? "\n存在失败用例" : "\n全部 PASS");
process.exit(failed ? 1 : 0);
