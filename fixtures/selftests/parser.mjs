// 自测④：解析器对 fixtures 两种格式都能出 Message；对故意打乱的行给出未识别报告。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseQqExport } from "../../src/ingest/parser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..");
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

function run(name) {
  const file = path.join(fixtures, name);
  const parsed = parseQqExport(name, readFileSync(file, "utf8"));
  console.log(`\n=== ${name}`);
  console.log(`format=${parsed.format}  消息数=${parsed.messages.length}  群=${parsed.groups.join("、") || "—"}`);
  console.log(`未识别=${parsed.unrecognized.length} 行  warnings=${parsed.warnings.length}`);
  for (const item of parsed.unrecognized.slice(0, 5)) console.log(`  第${item.line}行  ${item.sample}`);
  for (const warning of parsed.warnings) console.log(`  ! ${warning}`);
  for (const message of parsed.messages.slice(0, 3)) {
    console.log(`  ${message.ts}  ${message.sender || "(无发送者)"}  kind=${message.kind}  id=${message.id}`);
    console.log(`     ${message.text.slice(0, 46).replace(/\n/g, " ⏎ ")}`);
  }
  return parsed;
}

const a = run("qq-export-a-sample.txt");
const b = run("qq-export-b-sample.txt");
const broken = run("qq-export-broken.txt");

console.log("\n=== 断言行头格式（2026-10-11 12:11:05 罗雨(123456)）");
const headerMessage = a.messages.find((m) => /罗雨/.test(m.sender));
check("格式 A 出 Message", a.messages.length > 0, `${a.messages.length} 条`);
check("格式 A 群名识别", a.groups.length === 1, a.groups.join("、"));
check("格式 A 行头解析出 sender", Boolean(headerMessage), headerMessage && headerMessage.sender);
check("格式 A ts 为北京时间 ISO", Boolean(headerMessage) && /\+08:00$/.test(headerMessage.ts), headerMessage && headerMessage.ts);

console.log("\n=== 断言【群名】发送者 时间 格式");
check("格式 B 出 Message", b.messages.length > 0, `${b.messages.length} 条`);
check("格式 B 群名进 groupName", b.messages.every((m) => m.groupName === "示例年级群"), b.messages[0] && b.messages[0].groupName);
check("格式 B 短日期 10-11 也解析成 2026 年", b.messages.some((m) => m.ts.startsWith("2026-10-11")), b.messages[0] && b.messages[0].ts);

console.log("\n=== 断言真正打乱的文件给出未识别报告");
check("broken 文件仍有可识别消息", broken.messages.length > 0, `${broken.messages.length} 条`);
check("broken 文件报告了未识别行", broken.unrecognized.length > 0, `${broken.unrecognized.length} 行`);
check("未识别项带 line 与 sample", broken.unrecognized.every((u) => Number.isInteger(u.line) && typeof u.sample === "string"));

console.log("\n=== 断言 messageId 稳定（同输入同 id）");
const again = parseQqExport("qq-export-a-sample.txt", readFileSync(path.join(fixtures, "qq-export-a-sample.txt"), "utf8"));
check("两次解析 id 完全一致", again.messages.map((m) => m.id).join(",") === a.messages.map((m) => m.id).join(","));

if (failed) process.exitCode = 1;
