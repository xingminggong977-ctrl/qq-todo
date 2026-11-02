// 断言：store 不能让 attachmentFile 凭空蒸发——poller 下载完落库、pipeline 若干秒后才 read，
// 中间只要丢字段，附件正文解析在生产上永远不会触发。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../../src/store.js";
import { makeMessageId } from "../../src/shared/message.js";
import { createStubProvider } from "../../src/extract/provider.js";
import { runExtract } from "../../src/extract/pipeline.js";

const dataDir = mkdtempSync(join(tmpdir(), "qqdsh-a-attstore-"));
let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}  ${detail}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

const base = {
  groupName: "示例年级群",
  sender: "陈倩",
  ts: "2026-10-11T09:20:00+08:00",
  text: "见群文件《体测安全风险告知书》，各班级按要求组织填写。",
  source: "live",
};

try {
  const store = createStore({ dataDir });
  const file = fileURLToPath(new URL("../attachments/sample.pdf", import.meta.url));
  const fileId = makeMessageId(base.groupName, base.ts, base.sender, base.text);
  const withFile = { ...base, attachment: { name: "sample.pdf", size: 49157 }, attachmentFile: file };
  const numeric = { ...base, id: "m_bad_numeric", attachmentFile: 123 };
  const empty = { ...base, id: "m_bad_empty", attachmentFile: "" };
  const tooLong = { ...base, id: "m_bad_long", attachmentFile: "x".repeat(600) };
  const plain = { ...base, id: "m_plain_no_field" };

  const added = await store.addMessages([withFile, numeric, empty, tooLong, plain]);
  console.log(`imported=${added.imported} skipped=${added.skipped}`);

  const okRow = store.getMessage(fileId);
  check("带 attachmentFile 的消息读回来仍是同一字符串", okRow?.attachmentFile === file, String(okRow?.attachmentFile));
  check("attachment 元信息未被影响", okRow?.attachment?.name === "sample.pdf" && okRow?.attachment?.size === 49157, JSON.stringify(okRow?.attachment));
  check("id 未因新字段改变（仍等于 makeMessageId 结果）", okRow?.id === makeMessageId(base.groupName, base.ts, base.sender, base.text), okRow?.id);

  check("数字 123 → null", store.getMessage("m_bad_numeric")?.attachmentFile === null, String(store.getMessage("m_bad_numeric")?.attachmentFile));
  check("空字符串 → null", store.getMessage("m_bad_empty")?.attachmentFile === null, String(store.getMessage("m_bad_empty")?.attachmentFile));
  check("600 字符 → null", store.getMessage("m_bad_long")?.attachmentFile === null, String(store.getMessage("m_bad_long")?.attachmentFile));
  const plainRow = store.getMessage("m_plain_no_field");
  check("不传该字段 → null（不是 undefined）", plainRow?.attachmentFile === null && "attachmentFile" in plainRow, JSON.stringify(plainRow?.attachmentFile));
  check("JSON.stringify 后键仍在", JSON.parse(JSON.stringify(plainRow)).attachmentFile === null, JSON.stringify(plainRow).includes('"attachmentFile":null') ? "含 \"attachmentFile\":null" : "缺键");

  const listed = store.listMessages({ limit: 0 }).items;
  const listedOk = listed.find((m) => m.id === fileId);
  check("listMessages 也带着该字段", listedOk?.attachmentFile === file, String(listedOk?.attachmentFile));
  check("listMessages 里无字段的行是 null", listed.find((m) => m.id === "m_plain_no_field")?.attachmentFile === null);

  const reopened = createStore({ dataDir });
  check("重启后仍能从磁盘读回同一路径", reopened.getMessage(fileId)?.attachmentFile === file, String(reopened.getMessage(fileId)?.attachmentFile));
  check("重启后非法值仍是 null", reopened.getMessage("m_bad_long")?.attachmentFile === null);

  // 幂等：同一条再灌一次不带该字段，不应把已有路径抹掉
  const again = await store.addMessages([{ ...withFile, attachmentFile: undefined }]);
  check("重复灌入被跳过（幂等）", again.imported === 0 && again.skipped === 1, `imported=${again.imported} skipped=${again.skipped}`);
  check("已落库的路径没有被空值覆盖", store.getMessage(fileId)?.attachmentFile === file, String(store.getMessage(fileId)?.attachmentFile));

  // 老 store.json（无该键）也要能读
  const legacyDir = mkdtempSync(join(tmpdir(), "qqdsh-a-attstore-legacy-"));
  try {
    const legacy = createStore({ dataDir: legacyDir });
    await legacy.addMessages([{ ...base, id: "m_legacy" }]);
    const legacyRow = legacy.getMessage("m_legacy");
    check("老数据读回来 attachmentFile 是 null", legacyRow?.attachmentFile === null && "attachmentFile" in legacyRow, JSON.stringify(legacyRow?.attachmentFile));
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }

  // 生产链路端到端：poller 落库（带路径）→ 若干秒后 pipeline 从 store 读 → 附件正文拼进送模型文本
  const chainDir = mkdtempSync(join(tmpdir(), "qqdsh-a-attstore-chain-"));
  try {
    const chain = createStore({ dataDir: chainDir });
    const pdfAbs = join(process.cwd(), "fixtures", "attachments", "sample.pdf");
    const chainText = "见群文件《体测安全风险告知书》，各班级按要求组织填写。";
    await chain.addMessages([
      {
        groupName: "示例年级群",
        sender: "陈倩",
        ts: "2026-10-11T09:20:00+08:00",
        text: chainText,
        attachment: { name: "sample.pdf", size: 49157 },
        attachmentFile: pdfAbs,
        source: "live",
      },
    ]);
    const seen = [];
    const stub = createStubProvider();
    const spy = {
      ...stub,
      classify: async (messages, ctx) => {
        for (const m of messages) seen.push(m.text);
        return stub.classify(messages, ctx);
      },
    };
    const run = await runExtract({ env: {}, store: chain, provider: spy, batchSize: 10, concurrency: 1 });
    const sent = seen[0] || "";
    check("落库后的消息能把 attachmentFile 带进 pipeline", sent.includes("【附件正文】"), sent.includes("【附件正文】") ? "含标记" : "无标记");
    check("附件正文里的截止日期进入了判定文本", sent.includes("10月12日"), sent.includes("10月12日") ? "含 10月12日" : "缺日期");
    check("原文仍在附件正文之前", sent.indexOf("见群文件") === 0, sent.slice(0, 12));
    check("该条被判定为待办（附件让它不再漏抓）", run.todosCreated === 1, String(run.todosCreated));
    check("落库文本仍是原始正文（拼装只发生在送模型副本上）", chain.listMessages({ limit: 0 }).items[0].text === chainText, chain.listMessages({ limit: 0 }).items[0].text.slice(0, 12));
  } finally {
    rmSync(chainDir, { recursive: true, force: true });
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
