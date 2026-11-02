#!/usr/bin/env node
// 判定引擎离线评估：fixtures/eval/*.jsonl 上跑各判定器，输出 precision/recall/F1 + 逐条 diff。
//
// 三种判定器：
//   stub —— src/extract/provider.js 的本地规则引擎（确定性、不联网）
//   sim  —— prompt 能力覆盖模拟器：从系统提示词里检测「四类修正是否写进了 prompt」，
//           再按该能力位表在标注集上执行；它衡量的是 prompt 文本是否具备修复能力，
//           以及在标注集上的得分，不模拟真模型的自由发挥。
//   llm  —— 真模型（/chat/completions），需要 LLM_API_KEY；--prompt-version 选 v1/v2。
//
// 用法：
//   node scripts/eval-extract.mjs --stub-only
//   node scripts/eval-extract.mjs --judge=sim --file=fixtures/eval/prompt-gap.jsonl
//   node scripts/eval-extract.mjs --judge=llm --prompt-version=v2   # 无 key 自动跳过
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  PROMPT_VERSION,
  buildTitle,
  createOpenAIProvider,
  createStubProvider,
  resolveSystemPrompt,
} from "../src/extract/provider.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const EVAL_DIR = path.join(ROOT, "fixtures", "eval");
const BATCH = 24;
const CONTEXT_N = 2;

function parseArgs(argv) {
  const out = { judge: "", file: "", version: "", show: "", stubOnly: false, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--stub-only") out.stubOnly = true;
    else if (arg === "--json") out.json = true;
    else if (arg.startsWith("--judge=")) out.judge = arg.slice(8);
    else if (arg.startsWith("--file=")) out.file = arg.slice(7);
    else if (arg.startsWith("--show=")) out.show = arg.slice(7);
    else if (arg.startsWith("--prompt-version=")) out.version = arg.slice(17);
  }
  return out;
}

function loadCases(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const cases = [];
  for (const file of files) {
    const lines = readFileSync(path.join(dir, file), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const text = line.trim();
      if (!text) return;
      const item = JSON.parse(text);
      cases.push({
        id: String(item.id),
        groupName: String(item.groupName || "未知群"),
        sender: String(item.sender || ""),
        ts: String(item.ts),
        kind: "text",
        text: String(item.text || ""),
        label: item.label === "todo" ? "todo" : "noise",
        expectTitle: String(item.expectTitle || ""),
        expectDeadline: item.expectDeadline || null,
        expectConstraintMin: Number(item.expectConstraintMin) || 0,
        where: `${file}:${i + 1}`,
      });
    });
  }
  return cases;
}

/** 按 pipeline 的语义切批：每批带同群「上文」，上下文不参与打分。 */
async function predict(cases, classify) {
  const out = new Map();
  const seen = [];
  for (let i = 0; i < cases.length; i += BATCH) {
    const batch = cases.slice(i, i + BATCH);
    const context = seen.filter((m) => m.groupName === batch[0].groupName).slice(-CONTEXT_N);
    const result = await classify(batch, { context });
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const item of items) out.set(String(item.messageId), item);
    seen.push(...batch);
  }
  return out;
}

// ---------- prompt 能力覆盖检测 ----------
function capabilities(prompt) {
  return {
    noticeGate: /没写截止时间|没写时间|不要因为/.test(prompt),
    relativeTime: /顺延一周/.test(prompt),
    contextMerge: /拆成多条消息|接上条/.test(prompt),
    multiConstraint: /六类/.test(prompt),
  };
}

const DONE = /已经|已交|都交齐|已收到|等通知/;
const ASK = /是不是|可不可以|能不能|可以吗|用哪种|有座吗|还有吗|来不来|有人.*[吗嘛]|拼单|借我|笑死|哈哈|带我一个|卡在/;
const TODO_CUE = /请|务必|截止|提交|交到|上报|统计|填写|写清|报名|领取|签到|开会|会议|例会|考试|缴费|参保|收取|上传|打印|命名|文件名|携带|带好|带本|不得|逾期|请假|查寝|重做|抓紧|汇总|申报|参加|推\s*\d+\s*名|发我邮箱|补交|限两项|签字/;
const SPLIT = /接上条|补充|另外|还有一点/;
const ABS_DATE = /(\d{1,2})\s*[月./]\s*(\d{1,2})\s*[日号]?/;
const ISO_DATE = /(\d{4})-(\d{1,2})-(\d{1,2})/;
const WEEK_DAY = /(本|下|这)?(?:周|星期)([一二三四五六日天])/;
const REL_DAY = /(今天|明晚|明天|大后天|后天|今晚)/;
const WEEKDAY_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const REL_DELTA = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2, 大后天: 3 };
const STOP_BIGRAM = new Set(["班长", "老师", "同学", "大家", "通知", "今天", "明天", "后天", "时间", "群里", "上课", "一下", "我们", "你们", "已经", "可以", "需要", "晚上", "上午", "下午"]);

const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

function addDays(date, n) {
  const [y, m, d] = String(date).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return dayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function mondayOf(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(date, 1 - dow);
}

/** v1 只认绝对日期（月日/ISO）；v2 另把周几与今天/明天落成日期，「本周X」已过则顺延一周。 */
function deadlineFor(text, messageTs, caps) {
  const base = String(messageTs).slice(0, 10);
  const hit = ABS_DATE.exec(text);
  if (hit) {
    const month = Number(hit[1]);
    const day = Number(hit[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = Number(base.slice(0, 4));
      const candidate = dayKey(year, month, day);
      return candidate < addDays(base, -180) ? dayKey(year + 1, month, day) : candidate;
    }
  }
  const iso = ISO_DATE.exec(text);
  if (iso) return dayKey(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (!caps.relativeTime) return null;
  const wk = WEEK_DAY.exec(text);
  if (wk) {
    const offset = wk[1] === "下" ? 1 : 0;
    const target = addDays(mondayOf(base), offset * 7 + WEEKDAY_NUM[wk[2]] - 1);
    return target < base && offset === 0 ? addDays(target, 7) : target;
  }
  const rel = REL_DAY.exec(text);
  if (rel) return addDays(base, REL_DELTA[rel[1]] ?? 0);
  return null;
}

/** 两条消息是否指向同一件事：显式指代词，或存在一个非停用词的二字重合。 */
function sameSubject(prevText, text) {
  if (SPLIT.test(text)) return true;
  const prev = String(prevText || "");
  for (const run of String(text).match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (STOP_BIGRAM.has(bigram)) continue;
      if (prev.includes(bigram)) return true;
    }
  }
  return false;
}

const CONSTRAINT_PROBES = [
  [/附件\s*\d+/], [/告知书|承诺书|申请表|证明材料|成绩单|简历|照片底片/], [/打印|纸质/], [/手写|亲笔/],
  [/文件名\s*[^，。；]{0,6}/], [/按学号命名|学号[+_]?姓名|学号\+?医保|按部门命名/], [/PDF|Word|电子版|扫描件/],
  [/\d{3,4}\s*字以内/], [/学习通|超星|群文件|群相册|拍照上传|群接龙/], [/微信|邮箱|支付宝/],
  [/带上[^，。；]{0,6}|带好[^，。；]{0,6}|带本[^，。；]{0,6}|笔记本|计算器|学生证/],
  [/班长|辅导员|学委|部长|助教|组织部|教务办/], [/每人\s*\d+\s*元|限\s*[两二]\s*项|每班推\s*\d+\s*名/],
  [/以班级为单位|不漏一人/], [/逾期|不候|影响报销/], [/\d{1,2}[:：]\d{2}/],
  [/西楼|东楼|教学楼|博学楼|图书馆|实验楼|报告厅|会议室|办公室/, "地点"], [/\d+-\d{3}/, "地点"],
];

/** v1 只留 1 条约束；v2 按「地点/材料/格式/方式/联系人」等类别扫，最多 3 条。 */
function simConstraints(text, caps) {
  const out = [];
  for (const [re, tag] of CONSTRAINT_PROBES) {
    const hit = re.exec(text);
    if (!hit) continue;
    const value = `${tag || ""}${hit[0].replace(/\s+/g, "")}`.slice(0, 14);
    if (!out.includes(value)) out.push(value);
    if (!caps.multiConstraint || out.length >= 3) break;
  }
  return out;
}

function makeSim(version) {
  const prompt = resolveSystemPrompt(version);
  const caps = capabilities(prompt);
  async function classify(messages, ctx = {}) {
    const items = [];
    const carried = Array.isArray(ctx.context) ? ctx.context : [];
    const local = [];
    for (const m of messages) {
      const text = String(m.text || "");
      const history = [...carried, ...local];
      local.push(m);
      const cue = TODO_CUE.test(text);
      const blocked = DONE.test(text) || ASK.test(text);
      const own = deadlineFor(text, m.ts, caps);
      const todo = caps.noticeGate
        ? cue && !blocked && text.trim().length >= 4
        : cue && !blocked && Boolean(own) && text.trim().length >= 4;
      let deadline = todo ? own : null;
      if (todo && !deadline && caps.contextMerge) {
        for (let i = history.length - 1; i >= 0 && !deadline; i -= 1) {
          const prev = history[i];
          if (prev.groupName && prev.groupName !== m.groupName) continue;
          if (!sameSubject(prev.text, text)) continue;
          deadline = deadlineFor(String(prev.text || ""), prev.ts, caps);
        }
      }
      items.push({
        messageId: m.id,
        todo,
        title: todo ? buildTitle(text) : "",
        deadline,
        deadlineText: null,
        constraints: todo ? simConstraints(text, caps) : [],
        confidence: 0.7,
        reason: `sim:${version}${caps.noticeGate ? "" : "-strict"}`,
      });
    }
    return { items, provider: "sim", model: `sim-${version}`, costUsd: 0, usage: { promptTokens: 0, completionTokens: 0 } };
  }
  return { name: `sim-${version}`, model: `sim-${version}`, caps, classify };
}

// ---------- 打分 ----------
function score(cases, predictions) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let deadlineHit = 0;
  let deadlineExpect = 0;
  let constraintOk = 0;
  let constraintNeeded = 0;
  const diffs = [];
  for (const c of cases) {
    const item = predictions.get(c.id);
    const got = Boolean(item?.todo);
    const want = c.label === "todo";
    if (want && got) tp += 1;
    else if (!want && got) fp += 1;
    else if (want && !got) fn += 1;
    else tn += 1;
    let deadlineNote = "";
    if (want && got && c.expectDeadline) {
      deadlineExpect += 1;
      if (item.deadline === c.expectDeadline) deadlineHit += 1;
      else deadlineNote = ` 截止期望=${c.expectDeadline} 实得=${item.deadline ?? "null"}`;
    }
    if (want && got && c.expectConstraintMin >= 2) {
      constraintNeeded += 1;
      const n = Array.isArray(item.constraints) ? item.constraints.length : 0;
      if (n >= c.expectConstraintMin) constraintOk += 1;
      else deadlineNote += ` 约束期望>=${c.expectConstraintMin} 实得=${n}`;
    }
    if (want !== got || deadlineNote) {
      diffs.push(`${c.id} ${want ? "todo " : "noise"} → ${got ? "todo " : "noise"} | ${c.expectTitle || "-"}${deadlineNote} | ${c.text.slice(0, 34)}`);
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1, deadlineHit, deadlineExpect, constraintOk, constraintNeeded, diffs };
}

function row(name, version, s) {
  const p = (n) => n.toFixed(3);
  return [
    name.padEnd(10),
    version.padEnd(6),
    String(s.tp).padStart(3),
    String(s.fp).padStart(3),
    String(s.fn).padStart(3),
    String(s.tn).padStart(3),
    p(s.precision).padStart(9),
    p(s.recall).padStart(7),
    p(s.f1).padStart(6),
    `${s.deadlineHit}/${s.deadlineExpect}`.padStart(10),
    `${s.constraintOk}/${s.constraintNeeded}`.padStart(9),
  ].join("  ");
}

async function runJudge(cases, judge) {
  const predictions = await predict(cases, (batch, ctx) => judge.classify(batch, ctx));
  return { judge, predictions, score: score(cases, predictions) };
}

async function main() {
  const args = parseArgs(process.argv);
  const caseDir = args.file ? path.dirname(path.resolve(ROOT, args.file)) : EVAL_DIR;
  const cases = loadCases(caseDir);
  const todos = cases.filter((c) => c.label === "todo").length;
  const lines = [];
  const push = (s = "") => {
    lines.push(s);
    console.log(s);
  };
  push(`评估集：${cases.length} 条（todo ${todos} / noise ${cases.length - todos}），batch=${BATCH}，上文=${CONTEXT_N}`);
  push(`prompt 版本：${PROMPT_VERSION}`);
  for (const [version, probe] of Object.entries({ v1: resolveSystemPrompt("v1"), v2: resolveSystemPrompt("v2") })) {
    const caps = capabilities(probe);
    push(`  能力位 ${version}: noticeGate=${caps.noticeGate} relativeTime=${caps.relativeTime} contextMerge=${caps.contextMerge} multiConstraint=${caps.multiConstraint}`);
  }
  push();
  push("判定器       版本      TP  FP  FN  TN  precision  recall    F1    截止日命中  约束达标");
  push("-".repeat(96));

  const runs = [];
  const wantLlm = args.judge === "llm" || (!args.stubOnly && args.judge !== "sim" && args.judge !== "stub" && process.env.LLM_API_KEY);
  if (args.judge !== "sim" && args.judge !== "llm") runs.push(await runJudge(cases, createStubProvider()));
  if (args.judge !== "stub" && args.judge !== "llm") {
    runs.push(await runJudge(cases, makeSim("v1")));
    runs.push(await runJudge(cases, makeSim("v2")));
  }
  if (wantLlm) {
    if (!process.env.LLM_API_KEY) {
      push("跳过 llm：未配置 LLM_API_KEY（离线只跑 stub / sim）");
    } else {
      for (const version of args.version ? [args.version] : ["v1", "v2"]) {
        const provider = createOpenAIProvider({ ...process.env, LLM_PROMPT_VERSION: version });
        runs.push(await runJudge(cases, provider));
      }
    }
  }
  for (const run of runs) {
    const version = run.judge.promptVersion || (run.judge.caps ? (run.judge.caps.relativeTime ? "v2" : "v1") : "rules");
    push(row(run.judge.name, version, run.score));
  }
  push();
  for (const run of runs) {
    push(`### ${run.judge.name} 逐条 diff（${run.score.diffs.length} 条与标注不一致）`);
    if (!run.score.diffs.length) push("  （无）");
    for (const d of run.score.diffs) push(`  ${d}`);
    push();
  }
  if (args.show) {
    for (const id of args.show.split(",").map((s) => s.trim()).filter(Boolean)) {
      const c = cases.find((x) => x.id === id);
      if (!c) continue;
      push(`## 用例 ${id} | 标注=${c.label} 期望截止=${c.expectDeadline ?? "null"} | ${c.text}`);
      for (const run of runs) {
        const it = run.predictions.get(id) || {};
        push(`  ${run.judge.name.padEnd(8)} todo=${String(Boolean(it.todo)).padEnd(5)} deadline=${String(it.deadline ?? "null").padEnd(10)} constraints=${JSON.stringify(it.constraints || [])}`);
      }
      push();
    }
  }
  if (args.json) console.log(JSON.stringify(runs.map((r) => ({ judge: r.judge.name, ...r.score, diffs: undefined })), null, 2));
}

await main();
