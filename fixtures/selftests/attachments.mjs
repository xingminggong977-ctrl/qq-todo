// 自测⑪：附件正文抽取（PDF / DOCX / TXT）单元测试。真实夹具，不联网。
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractText, normalizeAttachmentText, readAttachmentText } from "../../src/extract/attachments.js";

const DIR = path.resolve("fixtures/attachments");
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const pdf = await readAttachmentText(path.join(DIR, "sample.pdf"), "sample.pdf");
const docx = await readAttachmentText(path.join(DIR, "sample.docx"), "sample.docx");
const txt = await readAttachmentText(path.join(DIR, "sample.txt"), "sample.txt");

console.log(`pdf  ok=${pdf.ok} kind=${pdf.kind} chars=${pdf.chars} head=${pdf.text.slice(0, 26)}`);
console.log(`docx ok=${docx.ok} kind=${docx.kind} chars=${docx.chars} head=${docx.text.slice(0, 26)}`);
console.log(`txt  ok=${txt.ok} kind=${txt.kind} chars=${txt.chars} head=${txt.text.slice(0, 26)}`);

check("pdf 抽取成功", pdf.ok && pdf.kind === "pdf", `${pdf.kind}/${pdf.chars}`);
check("pdf 含中文正文", pdf.text.includes("体测安全风险告知书"), pdf.text.slice(0, 20));
check("pdf 含「10月12日」", pdf.text.includes("10月12日"), "ok");
check("pdf 含联系人行", pdf.text.includes("陈倩"), "ok");
check("docx 抽取成功", docx.ok && docx.kind === "docx", `${docx.kind}/${docx.chars}`);
check("docx 含中文正文", docx.text.includes("体测安全风险告知书"), docx.text.slice(0, 20));
check("docx 含「10月12日」", docx.text.includes("10月12日"), "ok");
check("txt 抽取成功", txt.ok && txt.kind === "text", `${txt.kind}/${txt.chars}`);
check("txt 含「不漏一人」", txt.text.includes("不漏一人"), "ok");
check("txt 含「附件6需打印签字」", txt.text.includes("附件6需打印签字"), "ok");

// 后缀大小写不敏感
const upper = await extractText(readFileSync(path.join(DIR, "sample.txt")), "NOTICE.TXT");
check("后缀大小写不敏感（.TXT）", upper.ok && upper.kind === "text", `${upper.kind}`);

// 超大文件被拒（不解析，直接拒）
const big = Buffer.alloc(9 * 1024 * 1024, 0x20);
const bigRes = await extractText(big, "huge.pdf");
console.log(`big -> ${JSON.stringify({ ok: bigRes.ok, kind: bigRes.kind, reason: bigRes.reason })}`);
check("9MB 文件被拒", bigRes.ok === false && bigRes.kind === "unsupported", `${bigRes.kind}`);
check("拒因是「超过 8MB」", /超过 8MB/.test(bigRes.reason), bigRes.reason);

// 未知后缀
const xlsx = await extractText(Buffer.from("x"), "附件5-告知书.xlsx");
console.log(`xlsx -> ${JSON.stringify({ ok: xlsx.ok, kind: xlsx.kind, reason: xlsx.reason })}`);
check("未知后缀被拒", xlsx.ok === false && xlsx.kind === "unsupported", `${xlsx.kind}`);
check("未知后缀 reason 指明扩展名", xlsx.reason === "暂不支持 .xlsx", xlsx.reason);
check("无后缀文件被拒", (await extractText(Buffer.from("x"), "noext")).ok === false, "ok");

// 损坏 buffer 不抛
const brokenPdf = await extractText(Buffer.from("not a pdf at all", "utf8"), "broken.pdf");
const brokenDocx = await extractText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), "broken.docx");
console.log(`broken pdf -> ${JSON.stringify({ ok: brokenPdf.ok, kind: brokenPdf.kind, reason: brokenPdf.reason })}`);
console.log(`broken docx -> ${JSON.stringify({ ok: brokenDocx.ok, kind: brokenDocx.kind, reason: brokenDocx.reason })}`);
check("损坏的 pdf 不抛、ok=false", brokenPdf.ok === false, `${brokenPdf.kind}`);
check("损坏的 pdf 有可读 reason", /PDF 解析失败/.test(brokenPdf.reason), brokenPdf.reason);
check("损坏的 docx 不抛、ok=false", brokenDocx.ok === false, `${brokenDocx.kind}`);
check("损坏的 docx 有可读 reason", /DOCX 解析失败/.test(brokenDocx.reason), brokenDocx.reason);

// 截断
const longText = "第一行内容\n".repeat(80);
const cut = await extractText(Buffer.from(longText, "utf8"), "long.txt", { maxChars: 100 });
console.log(`cut -> ${JSON.stringify({ ok: cut.ok, chars: cut.chars, truncated: cut.truncated, len: cut.text.length })}`);
check("超 maxChars 被截断", cut.truncated === true, `truncated=${cut.truncated}`);
check("截断后 text 以「…（已截断）」结尾", cut.text.endsWith("…（已截断）"), cut.text.slice(-8));
check("chars 记录截断前长度", cut.chars === normalizeAttachmentText(longText).length, `${cut.chars}`);
check("截断后 text 长度≈ maxChars + 标记", cut.text.length === 100 + "…（已截断）".length, `${cut.text.length}`);

// 归一化：\r\n、连续空行、页码行
const messy = "第一段\r\n\r\n\r\n第二段\r\n-- 1 of 1 --\r\n  第三段  \r\n";
const clean = normalizeAttachmentText(messy);
console.log(`normalize -> ${JSON.stringify(clean)}`);
check("\\r\\n 被归一化为 \\n", !clean.includes("\r"), "ok");
check("连续空行压成一个", clean === "第一段\n\n第二段\n第三段", JSON.stringify(clean));
check("孤立页码行被去掉", !/--\s*1\s+of\s+1\s*--/.test(clean), "ok");

// 文件不存在 / 路径为空
const missing = await readAttachmentText(path.join(DIR, "not-there.pdf"), "not-there.pdf");
const emptyPath = await readAttachmentText("", "x.pdf");
console.log(`missing -> ${JSON.stringify({ ok: missing.ok, kind: missing.kind, reason: missing.reason })}`);
check("文件不存在不抛、ok=false", missing.ok === false, `${missing.kind}`);
check("文件不存在 reason 可读中文", /附件文件不存在/.test(missing.reason), missing.reason);
check("空路径不抛、ok=false", emptyPath.ok === false, emptyPath.reason);

console.log(failed ? "\n存在失败用例" : "\n全部 PASS");
process.exit(failed ? 1 : 0);
