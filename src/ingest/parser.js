// QQ 导出的 txt 解析。宁可多报「未识别」，也不静默丢消息。
import { looksLikeNoise, makeMessageId, normalizeKind } from "../shared/message.js";
import { buildISO } from "../shared/time.js";

const RE_FULL_TIME = String.raw`\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?`;
const RE_SHORT_TIME = String.raw`\d{1,2}[-/月]\d{1,2}日?\s+\d{1,2}:\d{2}(?::\d{2})?`;

// 形态一：2026-10-11 12:11:05 罗雨(123456)
const RE_HEADER_A = new RegExp(String.raw`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.+)$`);
// 形态二：【群名】发送者 2026-10-11 12:11:05（时间也可能在发送者前，或省略年份）
const RE_HEADER_B_NAME_FIRST = new RegExp(String.raw`^【([^】]{1,40})】\s*(.+?)\s+(${RE_FULL_TIME})\s*$`);
const RE_HEADER_B_TIME_FIRST = new RegExp(String.raw`^【([^】]{1,40})】\s*(${RE_FULL_TIME})\s+(.+?)\s*$`);
const RE_HEADER_B_SHORT = new RegExp(String.raw`^【([^】]{1,40})】\s*(.+?)\s+(${RE_SHORT_TIME})\s*$`);

const RE_GROUP_LINE = /^消息对象\s*[:：]\s*(.+)$/;
const RE_IGNORABLE = /^[=\-_*·—\s]*$|^消息记录|^消息分组\s*[:：]|^消息对象\s*[:：]|^导出时间|^==+$/;
const RE_ATTACHMENT = /【文件】\s*([^\s（(]+)/;

function splitSender(raw) {
  const s = String(raw ?? "").trim();
  let m = /^(.*?)\s*[（(]\s*(\d{4,12})\s*[)）]\s*$/.exec(s);
  if (m) return { sender: m[1].trim(), qq: m[2] };
  m = /^(.*?)\s*<\s*(\d{4,12})@qq\.com\s*>\s*$/i.exec(s);
  if (m) return { sender: m[1].trim(), qq: m[2] };
  return { sender: s, qq: "" };
}

function parseFullTimestamp(text) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text).trim());
  if (!m) return null;
  return buildISO(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
}

function parseShortTimestamp(text, year) {
  const m = /^(\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text).trim());
  if (!m || !year) return null;
  return buildISO(year, +m[1], +m[2], +m[3], +m[4], +(m[5] || 0));
}

function snippet(line) {
  const s = String(line ?? "").trim();
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

export function parseExport(content, options = {}) {
  if (typeof content !== "string") throw new TypeError("content 必须是字符串");
  const filename = options.filename || "导入.txt";
  const fallbackGroup = options.groupName || filename.replace(/\.[^.]+$/, "");
  const source = `qq-export:${filename}`;
  const text = content.replace(/^\uFEFF/, "");

  const messages = [];
  const unrecognized = [];
  const warnings = [];
  const formats = new Set();
  let groupName = fallbackGroup;
  let current = null;
  let currentYear = null;

  function finalize() {
    if (!current) return;
    const bodyText = current.body.join("\n").trim();
    const attachmentMatch = RE_ATTACHMENT.exec(bodyText);
    const attachment = attachmentMatch ? { name: attachmentMatch[1], size: null } : null;
    const kind = normalizeKind(bodyText, attachment);
    const ts = current.ts;
    messages.push({
      id: makeMessageId(current.groupName, ts, current.sender, bodyText),
      groupName: current.groupName,
      sender: current.sender,
      ts,
      kind,
      text: bodyText,
      attachment,
      source,
      noise: looksLikeNoise(bodyText, kind),
      raw: [current.header, ...current.body].join("\n"),
    });
    current = null;
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) {
      // 空行当作消息分隔（QQ 导出以空行切消息）
      finalize();
      continue;
    }

    const groupLine = RE_GROUP_LINE.exec(line);
    if (groupLine) {
      finalize();
      if (!options.groupName) groupName = groupLine[1].trim();
      continue;
    }
    if (RE_IGNORABLE.test(line)) {
      finalize();
      continue;
    }

    let header = null;

    const a = RE_HEADER_A.exec(line);
    if (a) {
      currentYear = +a[1];
      header = { groupName, ts: buildISO(+a[1], +a[2], +a[3], +a[4], +a[5], +(a[6] || 0)), rest: a[7] };
      formats.add("qq-txt");
    }

    if (!header) {
      const b1 = RE_HEADER_B_NAME_FIRST.exec(line);
      const b2 = RE_HEADER_B_TIME_FIRST.exec(line);
      if (b1 || b2) {
        const group = (b1 || b2)[1].trim();
        const senderPart = b1 ? b1[2] : b2[3];
        const timePart = b1 ? b1[3] : b2[2];
        const ts = parseFullTimestamp(timePart);
        if (ts) {
          currentYear = +timePart.slice(0, 4);
          header = { groupName: options.groupName || group, ts, rest: senderPart };
          formats.add("bracket-group");
        }
      }
    }

    if (!header) {
      const b3 = RE_HEADER_B_SHORT.exec(line);
      if (b3 && currentYear) {
        const ts = parseShortTimestamp(b3[3], currentYear);
        if (ts) {
          header = { groupName: options.groupName || b3[1].trim(), ts, rest: b3[2] };
          formats.add("bracket-group-short");
        }
      }
    }

    if (header) {
      finalize();
      if (!header.ts) {
        unrecognized.push({ line: lineNo, sample: snippet(line) });
        continue;
      }
      const { sender } = splitSender(header.rest);
      current = { header: rawLine, groupName: header.groupName, sender, ts: header.ts, body: [] };
      continue;
    }

    if (current) {
      current.body.push(rawLine);
      continue;
    }

    unrecognized.push({ line: lineNo, sample: snippet(line) });
  }
  finalize();

  const groups = [...new Set(messages.map((m) => m.groupName))];
  const format = formats.size === 0 ? "unknown" : [...formats].join("+");
  if (formats.size === 0) warnings.push(`没有识别出任何消息头（共 ${lines.length} 行），请确认导出格式`);
  if (unrecognized.length) {
    const first = unrecognized.slice(0, 5).map((u) => `第${u.line}行: ${u.sample}`).join(" | ");
    warnings.push(`有 ${unrecognized.length} 行无法识别，前 5 行：${first}`);
  }
  const groupIdentified = groups.some((g) => g && g !== fallbackGroup);
  if (messages.length && !options.groupName && !groupIdentified) {
    warnings.push(`未从内容识别到群名，使用「${fallbackGroup}」`);
  }

  return { messages, warnings, unrecognized, groups, format };
}

export function parseQqExport(filename, content, options = {}) {
  return parseExport(content, { ...options, filename });
}

export default parseQqExport;
