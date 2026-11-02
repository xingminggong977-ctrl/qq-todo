// 判定来源：stub（纯本地规则、确定性、不联网）与 openai（/chat/completions）。
// 两者对外的 classify() 返回同一口径，pipeline 不区分。
import { toBeijingISO } from "../shared/message.js";

export const PROMPT_VERSION = "todo-prompt-v3";

const MAX_TEXT_FOR_PROMPT = 500;
const MAX_TITLE = 30;
const MAX_CONSTRAINT = 14;

// ---------- 规则表（stub 的全部判定依据，可单独审查） ----------

const TODO_CUES = [
  "@全体成员",
  "@所有人",
  "【通知】",
  "通知",
  "请各",
  "请大家",
  "请同学们",
  "麻烦各位",
  "截止",
  "前完成",
  "报名",
  "提交",
  "上交",
  "收取",
  "登记",
  "统计",
  "填报",
  "填写",
  "审核",
  "领取",
  "参会",
  "参加",
  "例会",
  "开会",
  "务必",
  "要求",
  "作业",
  "考试",
  "缴费",
  "评审",
];

const CHAT_CUES = [
  "有人",
  "一起",
  "吗",
  "吧",
  "谁有",
  "有没有",
  "求问",
  "求分享",
  "求个",
  "笑死",
  "哈哈",
  "服了",
  "吐槽",
  "我请客",
  "吃饭",
  "打球",
  "去不去",
  "真的",
  "其实",
];

const DEADLINE_MARKS = ["前", "之前", "截止", "以前", "截至"];

const WEEKDAY_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

const CONSTRAINT_RULES = [
  { label: "以班级为单位", re: /以班级为单位|按班级组织/ },
  { label: "不漏一人", re: /不漏一人|一人不漏/ },
  { label: "不能代签", re: /不能代签|不得代签|禁止代签/ },
  { label: "需本人签字", re: /本人签字|签字确认|签名/ },
  { label: "需纸质材料", re: /纸质|打印出来|打印版/ },
  { label: "需签字盖章", re: /盖章|加盖公章/ },
  { label: "群接龙", re: /接龙/ },
  { label: "填写汇总表", re: /汇总表|填表|表格/ },
  { label: "统计名单", re: /统计名单|名单/ },
  { label: "按学号命名", re: /按学号命名|学号命名|学号\+姓名|学号姓名/ },
  { label: "提交到学习通", re: /学习通|超星/ },
  { label: "发到群文件", re: /群文件|群相册/ },
  { label: "发邮箱", re: /邮箱|email|邮件/i },
  { label: "线下提交", re: /交至|送到|交给我|办公室|当面提交/ },
  { label: "放弃承诺书", re: /放弃承诺书|放弃书/ },
  { label: "需辅导员审批", re: /辅导员审批|找辅导员签字/ },
  { label: "个人单独提交", re: /不要个人单独发送|个人单独提交/ },
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function baseDateParts(messageTs) {
  const iso = toBeijingISO(messageTs) || toBeijingISO(Date.now());
  return {
    iso,
    year: +iso.slice(0, 4),
    month: +iso.slice(5, 7),
    day: +iso.slice(8, 10),
    date: iso.slice(0, 10),
  };
}

function dateKey(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00+08:00`) - Date.parse(`${a}T00:00:00+08:00`)) / 86400000);
}

function pickYear(year, month, day, baseDate) {
  const candidate = dateKey(year, month, day);
  // 跨年：提到的日期比消息日期早半年以上，按明年算（12月说「1月5日前」）
  if (daysBetween(candidate, baseDate) > 180) return year + 1;
  return year;
}

function weekdayDate(baseDate, targetDow, weekOffset) {
  // 纯日历日运算：用 UTC 承载「北京日期」的 y-m-d，避免 +08:00 解析后再取 UTC 分量带来的整日偏移。
  const [y, m, d] = String(baseDate).split("-").map(Number);
  const baseDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // 1=周一 … 7=周日
  let delta = targetDow - baseDow;
  if (delta < 0) delta += 7;
  if (weekOffset > 0) delta += 7 * weekOffset;
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function hasDeadlineMark(after) {
  return Boolean(markIndex(after));
}

// 正文里第一个截止标记（前/之前/截止…）的位置，用来截整齐的原文片段。
// 注意「提前」不是截止时间，必须排除。
function markIndex(after) {
  let best = null;
  for (const mark of DEADLINE_MARKS) {
    let from = 0;
    for (;;) {
      const at = after.indexOf(mark, from);
      if (at < 0) break;
      from = at + 1;
      if (mark === "前" && after[at - 1] === "提") continue;
      const end = at + mark.length;
      if (!best || end < best.end) best = { at, end };
      break;
    }
  }
  return best;
}

/**
 * 从正文里抽截止日期。优先级：
 *  1. 「10月12日24点前」「10月12日19:30」这类带具体时刻的（作业/会议时间点）
 *  2. 「10月12日前」这类绝对日期
 *  3. 「2026-10-12」「本周五17点前」「明天前」这类相对表达
 * 返回 {deadline, deadlineText, kind} 或 null。
 */
export function extractDeadline(text, messageTs) {
  const source = String(text ?? "");
  const base = baseDateParts(messageTs);

  const md = /(\d{1,2})月(\d{1,2})日/g;
  let placeholder = null;
  let match;
  while ((match = md.exec(source)) !== null) {
    const [, mm, dd] = match;
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 16);
    const year = pickYear(base.year, +mm, +dd, base.date);
    const deadline = dateKey(year, +mm, +dd);
    const timeMatch = /(\d{1,2})[:：点](\d{2})?/.exec(after.slice(0, 10));
    const markAt = markIndex(after);
    if (markAt) {
      return { deadline, deadlineText: `${match[0]}${after.slice(0, markAt.end)}`.slice(0, 20), kind: "deadline" };
    }
    if (timeMatch) {
      return { deadline, deadlineText: `${match[0]}${timeMatch[0]}`.slice(0, 20), kind: "point" };
    }
    if (!placeholder) placeholder = { deadline, deadlineText: match[0], kind: "placeholder" };
  }
  if (placeholder) return placeholder;

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(source);
  if (iso) {
    const after = source.slice(iso.index + iso[0].length, iso.index + iso[0].length + 12);
    return {
      deadline: dateKey(+iso[1], +iso[2], +iso[3]),
      deadlineText: iso[0].slice(0, 20),
      kind: hasDeadlineMark(after) ? "deadline" : "placeholder",
    };
  }

  const week = /(本|下|这)?(?:周|星期)([一二三四五六日天])([^，。；;\n]{0,8})/.exec(source);
  if (week) {
    const offset = week[1] === "下" ? 1 : 0;
    const target = weekdayDate(base.date, WEEKDAY_NUM[week[2]], offset);
    if (hasDeadlineMark(week[3])) {
      return { deadline: target, deadlineText: week[0].trim(), kind: "weekday" };
    }
  }

  const relative = /(今天|明天|后天|今晚)[^，。；;\n]{0,8}?(?<!提)前/.exec(source);
  if (relative) {
    const delta = relative[1] === "明天" ? 1 : relative[1] === "后天" ? 2 : 0;
    const ms = Date.parse(`${base.date}T00:00:00+08:00`) + delta * 86400000;
    return { deadline: toBeijingISO(ms).slice(0, 10), deadlineText: relative[0].trim(), kind: "relative" };
  }

  return null;
}

function stripMarkers(text) {
  let out = String(text ?? "").trim();
  out = out.replace(/^【文件】[^\n]*\n?/, "");
  out = out.replace(/^(【[^】]{1,12}】|\[[^\]]{1,12}\])\s*/, "");
  out = out.replace(/^@(全体成员|所有人)\s*/, "");
  out = out.replace(/^(各位同学|各位|同学们|大家)[：:，,]\s*/, "");
  out = out.replace(/^(请大家|请各位同学|请各班|请|麻烦各位|麻烦)\s*/, "");
  return out.trim();
}

export function buildTitle(text) {
  const stripped = stripMarkers(text);
  const withoutLeadDate = stripped.replace(/^(\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})(\s*\d{1,2}[:：点]\d{2})?\s*(前后|前|当天)?\s*[，,]?\s*/, "");
  const clause = ((withoutLeadDate || stripped).split(/[。！？!?；;\n]/)[0] || stripped).split(/[，,]/)[0].trim();
  const about = /^关于(.+?)(?:的)?(通知|公告|提醒|安排|要求|说明|事宜|工作)$/.exec(clause);
  const core = (about ? about[1].replace(/的$/, "") : clause).replace(/[，,。；;：:、\s]+$/, "");
  const title = core || clause || stripped;
  return title.slice(0, MAX_TITLE);
}

export function buildConstraints(text) {
  const source = String(text ?? "");
  const picked = [];
  for (const rule of CONSTRAINT_RULES) {
    if (picked.length >= 3) break;
    if (!rule.re.test(source)) continue;
    if (picked.includes(rule.label)) continue;
    picked.push(rule.label.slice(0, MAX_CONSTRAINT));
  }
  const place = /(西楼|东楼|主楼|实验楼|教学楼|一教|二教|三教|图书馆)\s*[A-Za-z]?(\d{2,4})?/.exec(source);
  if (place && picked.length < 3) {
    const label = `${place[1]}${place[2] || ""}`.slice(0, MAX_CONSTRAINT);
    if (!picked.includes(label)) picked.push(label);
  }
  const clock = /(\d{1,2})[:：](\d{2})/.exec(source);
  if (clock && picked.length < 3) {
    const label = `${clock[1]}:${clock[2]}`;
    if (!picked.includes(label)) picked.push(label);
  }
  return picked.slice(0, 3);
}

function detectCues(text, cues) {
  const hits = [];
  for (const cue of cues) if (text.includes(cue)) hits.push(cue);
  return hits;
}

/** stub 的单条判定：纯函数，输入相同输出必然相同。 */
export function classifyByRules(message) {
  const text = String(message.text ?? "");
  const taskCues = detectCues(text, TODO_CUES);
  const chatCues = detectCues(text, CHAT_CUES);
  const deadline = extractDeadline(text, message.ts);
  const taskStrength = taskCues.length + (deadline && deadline.kind !== "placeholder" ? 2 : 0) + (deadline ? 1 : 0);
  const isTodo = taskStrength >= 2 && chatCues.length === 0 && text.trim().length >= 4;
  const confidence = Math.min(
    0.95,
    Math.round((0.4 + taskCues.length * 0.06 + (deadline ? 0.15 : 0) + (chatCues.length === 0 ? 0.08 : -0.1)) * 100) / 100,
  );

  if (!isTodo) {
    return {
      messageId: message.id,
      todo: false,
      title: "",
      deadline: deadline ? deadline.deadline : null,
      deadlineText: deadline ? deadline.deadlineText : null,
      constraints: [],
      confidence: Math.max(0.05, Math.min(0.5, confidence)),
      reason: chatCues.length ? `闲聊口吻（${chatCues.slice(0, 2).join("、")}），没有可执行动作` : "没有明确的可执行动作",
      evidence: { taskCues, chatCues, deadline: deadline ? deadline.kind : null },
    };
  }

  const constraints = buildConstraints(text);
  return {
    messageId: message.id,
    todo: true,
    title: buildTitle(text),
    deadline: deadline ? deadline.deadline : null,
    deadlineText: deadline ? deadline.deadlineText : null,
    constraints,
    confidence,
    reason: `命中${taskCues.slice(0, 2).join("、")}${deadline ? `，含时间线索「${deadline.deadlineText}」` : "，无明确截止"}${constraints.length ? `，需${constraints[0]}` : ""}`.slice(0, 40),
    evidence: { taskCues, chatCues, deadline: deadline ? deadline.kind : null },
  };
}

// ---------- stub provider ----------

export function createStubProvider() {
  const hits = new Map();
  const totals = { calls: 0, items: 0, todos: 0 };

  async function classify(messages, ctx = {}) {
    if (ctx.signal && ctx.signal.aborted) throw new Error("已取消");
    const startedAt = toBeijingISO(Date.now());
    const items = [];
    for (const message of messages) {
      const result = classifyByRules(message);
      for (const cue of result.evidence.taskCues) hits.set(cue, (hits.get(cue) || 0) + 1);
      items.push(result);
      totals.items += 1;
      if (result.todo) totals.todos += 1;
    }
    totals.calls += 1;
    return {
      items,
      provider: "stub",
      model: "rules-v1",
      startedAt,
      finishedAt: toBeijingISO(Date.now()),
      usage: { promptTokens: 0, completionTokens: 0 },
      costUsd: 0,
      parseOk: true,
      finishReason: "stop",
      raw: null,
    };
  }

  return {
    name: "stub",
    kind: "stub",
    model: "rules-v1",
    classify,
    usage: () => ({ promptTokens: 0, completionTokens: 0, costUsd: 0 }),
    // 规则命中表：给文档/演示页用，说明「为什么判成待办」
    stats: () => ({ calls: totals.calls, items: totals.items, todos: totals.todos, topCues: [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) }),
  };
}

// ---------- openai provider ----------

// v1 原文保留：评估要拿它做对照（scripts/eval-extract.mjs --prompt-version v1）
export const SYSTEM_PROMPT_V1 = [
  "你是 QQ 群消息的待办抽取器。输入是一批群消息，每条带 id。",
  "只输出 JSON，形如 {\"items\":[{...}]}，items 必须覆盖每一条输入消息（按 messageId 一一对应）。",
  "每个 item 字段：",
  '  messageId: string，原样复制输入里的 id；',
  '  todo: boolean，只有「有明确可执行动作 + 需要某人在某个时间前做点什么」才算 true；纯闲聊、约饭、吐槽、表情、已完成的通报都算 false；',
  '  title: string，待办标题，<=30 字，动词开头，去掉「关于…的通知」这类外壳；',
  '  deadline: string|null，YYYY-MM-DD，绝对日期；能从消息时间 + 「明天/本周五/10月12日」推出具体日期时必须给出，推不出填 null；',
  '  deadlineText: string|null，原文中的截止表达，如「10月12日24点前」；',
  '  constraints: string[]，0-3 条，每条 <=14 字，只写原文明确的要求（如「以班级为单位」「不能代签」「西楼117」）；不要编造；',
  '  confidence: number，0-1；',
  '  reason: string，<=40 字，说明判定依据。',
  '禁止输出思考过程或 markdown 代码块，只输出 JSON。',
].join("\n");

// v2：补上四类指令 —— 通知/闲聊判定口径、相对时间落日期、拆条通知的上文、constraints 多通道扫描。
// schema 与 v1 完全一致（字段不增不减），pipeline.normalizeClassification 不需要改。
export const SYSTEM_PROMPT = `你是 QQ 群消息的待办抽取器。输入是一批群消息（每条带 id），可能附带「上文」。只输出 JSON：{"items":[{...}]}，items 覆盖每条输入消息（messageId 一一对应）；上文只作参考，绝不为上文单独输出 item。
字段与 v1 相同：messageId, todo, title, deadline, deadlineText, constraints, confidence, reason。
每条输入消息都必须出现在 items 里：短句、表情、闲聊也要输出 todo:false 的 item；漏掉某条即视为未作答。

【1. 通知还是闲聊】
true 信号：@全体成员 / 请各 / 务必 / 截止 / 提交 / 报名 / 签到 / 开会 / 缴费 / 上传 / 交到 / 领取 / 携带 / 上报 / 统计（命中两条即倾向 true）。
false 反例：约饭约自习、拼单、吐槽、表情、求推荐、已经办完（「都交齐了」「已收到」）。
唯一裁决问题：有没有具体的人必须做某件具体的事？有→true（没写时间也算）；只是让人知道→false。学院/学生会/辅导员发的通知几乎都是 true，不要因为没写截止时间判 false。

【2. 时间落成 YYYY-MM-DD】
基准 = 消息自己的「时间」和首行的「今天」。先取消息日所在周的周一再推：本周X/这周X=该周X；下周X=+7 天；X月Y日=补年（与消息日差 >180 天则跨年 ±1）；今天/明天/后天/今晚/明早=±N 天。推出的日期早于消息日（如周日说「本周五」）就顺延一周。24点/中午/早八只影响时刻，deadline 只要日期。没有任何时间线索才填 null。deadlineText 抄原文短语，<=20 字。

【3. 一条通知拆成多条消息】
出现「接上条」「补充一下」「上面那条」「就按上面说的时间」等指代时，从上文取 title/deadline/地点补齐本条；上文只是「稍后通知」时，本条给的时间地点写进 constraints。同一条通知不要输出成两个 item。

【4. constraints 至少扫六类】
对象、地点、材料与附件、格式与命名、方式（学习通/线下/接龙）、联系人。命中就写，最多 3 条、每条 <=14 字、只写原文有的；同时有「地点+材料+格式」时拆成 2-3 条而不是只留 1 条。

【5. 示例】
[m1] 群=计科2201 | 班长 | 2026-10-11 09:20 正文：@全体成员 本周五前把实践报告交到学习通，命名「学号_姓名」，纸质版交学委。
{"items":[{"messageId":"m1","todo":true,"title":"提交实践报告","deadline":"2026-10-16","deadlineText":"本周五前","constraints":["学习通提交","命名学号_姓名","纸质交学委"],"confidence":0.92,"reason":"有提交要求与周五截止"}]}
[m2] 群=计科2201 | 罗雨 | 2026-10-11 21:05 正文：有人明天早八一起去西楼自习吗，占两个座
{"messageId":"m2","todo":false,"title":"","deadline":null,"deadlineText":null,"constraints":[],"confidence":0.9,"reason":"约自习，无必须做的事"}
[m3] 群=电气学院学生会 | 文宣部 | 2026-10-11 19:30 正文：下周一 19:00 在 3 号楼 402 开例会，各部部长带本部门月度计划，纸质一份。
{"messageId":"m3","todo":true,"title":"参加学生会例会","deadline":"2026-10-12","deadlineText":"下周一 19:00","constraints":["3号楼402","带月度计划","纸质一份"],"confidence":0.9,"reason":"会议通知，有时间地点与材料"}
[m4] 群=计科2201 | 学委 | 2026-10-11 10:02 正文：接上条，补充一下：实验报告只收 PDF，文件名按学号命名。上文：[m0] 2026-10-10 16:40 正文：本周日 22:00 前提交实验报告到学习通
{"messageId":"m4","todo":true,"title":"按格式提交实验报告","deadline":"2026-10-11","deadlineText":"本周日 22:00","constraints":["只收PDF","按学号命名","学习通提交"],"confidence":0.88,"reason":"补充上条的提交格式"}
以上 m2-m4 只列 item，外层同样是 {"items":[...]}。

禁止输出思考过程或 markdown 代码块，只输出 JSON。`;

// v3：真群里最大的误报来源不是「通知判成闲聊」，而是「对话里的建议判成任务」。
// 实测 6 条线上待办里 6 条都是这种（「规范学院名称书写」「核对材料准确性」「回复确认」），
// 加一道「谁必须做」的硬门槛，把没有交付物、没有下达语气的讨论挡在外面。
const V3_GATE = `【1.5 硬门槛：这条消息是在「下达要求」吗】（v3 新增，三项全过才允许 todo:true）
a) 有明确的执行者，且不是说话人自己：@某人 / 各班 / 全体成员 / 你 / 大家 / 学委 / 班长 / 各部门 / 各负责人。
b) 有一个能被检查的交付物或到场动作：提交、上传、填写、报名、签到、开会、到场、领取、携带、缴费、交到某处、回复确认。
c) 语气是下达而非讨论：通知 / 请 / 务必 / 需 / 截止 / 要求 / 安排。
以下一律 todo:false，即使读起来像任务：建议与评价（「最好用 X」「这样更规范」）、让助手或 AI 去做（「帮我看下」「你生成一份」）、提问与求解释（「是不是」「为什么」）、自我介绍与状态汇报（「我叫…」「我做完了」）、已完成描述（「都交齐了」「已收到」）、单独的平台名或链接或口号、纯应答。
a、b、c 缺任何一条，或这条消息没有任何时间/地点/材料/交付物等具体要素，就判 false，confidence 不高于 0.5，reason 写「对话中的建议或讨论，不是下达给收件人的要求」。`;

export const SYSTEM_PROMPT_V3 = SYSTEM_PROMPT.replace(
  "【2. 时间落成",
  `${V3_GATE}\n\n【2. 时间落成`
);

export const PROMPT_VERSIONS = { v1: SYSTEM_PROMPT_V1, v2: SYSTEM_PROMPT, v3: SYSTEM_PROMPT_V3 };

export function resolveSystemPrompt(version) {
  const key = String(version || "").toLowerCase();
  return PROMPT_VERSIONS[key] || SYSTEM_PROMPT_V3;
}

export function buildUserPrompt(messages, context = []) {
  const lines = [`今天是 ${toBeijingISO(Date.now()).slice(0, 10)}（北京时间）。共 ${messages.length} 条消息：`, ""];
  if (Array.isArray(context) && context.length) {
    // 只给模型补上下文（拆条通知），不要求它给这些消息出 item
    lines.push("【上文参考：仅用于消解「上面那条」「接上条」这类指代，不要为它们输出 item】");
    for (const m of context) {
      const text = String(m.text ?? "").replace(/\n/g, " / ").slice(0, MAX_TEXT_FOR_PROMPT);
      lines.push(`[${m.id}] 群=${m.groupName} | 发送者=${m.sender} | 时间=${m.ts}`);
      lines.push(`正文：${text}`);
    }
    lines.push("");
  }
  for (const m of messages) {
    const text = String(m.text ?? "").replace(/\n/g, " / ").slice(0, MAX_TEXT_FOR_PROMPT);
    lines.push(`[${m.id}] 群=${m.groupName} | 发送者=${m.sender} | 时间=${m.ts} | 类型=${m.kind}`);
    lines.push(`正文：${text}`);
    lines.push("");
  }
  return lines.join("\n");
}

function clampText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeItem(raw) {
  const constraints = (Array.isArray(raw?.constraints) ? raw.constraints : [])
    .filter((c) => typeof c === "string" && c.trim())
    .slice(0, 3)
    .map((c) => clampText(c, MAX_CONSTRAINT));
  const deadlineText = raw?.deadlineText ? clampText(raw.deadlineText, 20) : null;
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.deadline ?? "")) ? String(raw.deadline) : null;
  const confidence = Number(raw?.confidence);
  return {
    messageId: String(raw?.messageId ?? ""),
    todo: Boolean(raw?.todo),
    title: clampText(raw?.title, MAX_TITLE),
    deadline,
    deadlineText,
    constraints,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    reason: clampText(raw?.reason, 40),
  };
}

function parseModelJson(content) {
  const text = String(content ?? "").trim();
  if (!text) throw new Error("模型返回空内容");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const payload = fenced ? fenced[1] : text;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    const start = payload.indexOf("{");
    const end = payload.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`模型返回不是 JSON：${text.slice(0, 120)}`);
    parsed = JSON.parse(payload.slice(start, end + 1));
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.results)) return parsed.results;
  throw new Error("模型返回缺少 items 数组");
}

export function createOpenAIProvider(env = {}) {
  const baseUrl = String(env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = String(env.LLM_API_KEY || "");
  const model = String(env.LLM_MODEL || "gpt-4o-mini");
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 90000;
  const priceIn = Number.isFinite(Number(env.LLM_PRICE_IN)) ? Number(env.LLM_PRICE_IN) : 0.14;
  const priceOut = Number.isFinite(Number(env.LLM_PRICE_OUT)) ? Number(env.LLM_PRICE_OUT) : 0.28;
  const maxAttempts = 3;
  const promptKey = String(env.LLM_PROMPT_VERSION || PROMPT_VERSION.replace("todo-prompt-", "")).toLowerCase();
  const systemPrompt = resolveSystemPrompt(promptKey);
  const totals = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };

  async function postOnce(payload, signal) {
    const timer = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timer]) : timer;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: composed,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error(`LLM 响应不是 JSON：${text.slice(0, 120)}`);
      err.retryable = true;
      throw err;
    }
  }

  async function classify(messages, ctx = {}) {
    if (!apiKey) throw new Error("LLM_API_KEY 未配置，无法使用 openai provider");
    if (ctx.signal && ctx.signal.aborted) throw new Error("已取消");
    const startedAt = toBeijingISO(Date.now());
    const payload = {
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildUserPrompt(messages, ctx.context) },
      ],
    };

    let lastError = null;
    let body = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        body = await postOnce(payload, ctx.signal);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const retryable = err.retryable !== false && !(ctx.signal && ctx.signal.aborted) && err.status !== 401 && err.status !== 400;
        if (attempt >= maxAttempts || !retryable) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }
    if (lastError) throw lastError;

    const usage = body?.usage || {};
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;
    const costUsd = (promptTokens * priceIn + completionTokens * priceOut) / 1e6;
    totals.calls += 1;
    totals.promptTokens += promptTokens;
    totals.completionTokens += completionTokens;
    totals.costUsd += costUsd;

    const known = new Set(messages.map((m) => m.id));
    // parseOk=false = 模型没吐出可解析的 JSON（上层据此才走重试/拆批）；
    // parseOk=true 但某条没有 item = 模型认为它不是待办（implicit negative，不重试）。
    let parseOk = true;
    let parsed = [];
    try {
      parsed = parseModelJson(body?.choices?.[0]?.message?.content);
    } catch (err) {
      parseOk = false;
      parsed = [];
    }
    const items = parsed
      .map(normalizeItem)
      // 模型编造的 id 一律丢弃，避免把待办挂到不存在的消息上
      .filter((item) => known.has(item.messageId));

    return {
      items,
      provider: "openai",
      model,
      startedAt,
      finishedAt: toBeijingISO(Date.now()),
      usage: { promptTokens, completionTokens },
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      parseOk,
      finishReason: typeof body?.choices?.[0]?.finish_reason === "string" ? body.choices[0].finish_reason : null,
      raw: body,
    };
  }

  return {
    name: "openai",
    kind: "openai",
    model,
    promptVersion: promptKey,
    classify,
    usage: () => ({ ...totals }),
    stats: () => ({ ...totals }),
  };
}

export function createProvider(env = {}) {
  const name = String(env.LLM_PROVIDER || "stub").toLowerCase();
  if (name === "openai") return createOpenAIProvider(env);
  if (name !== "stub") console.warn(`[extract] 未知的 LLM_PROVIDER=${name}，回退到 stub`);
  return createStubProvider();
}

export default createProvider;
