// 演示用假数据：贵州大学班级/年级/学院群仿真。
// 种子固定 + 时间锚点取「运行时今天」 => 同一天内多次生成完全一致；
// 273 条消息 / 47 条待办，对齐视频里的真实数字；待办截止永远落在未来几天，
// 并刻意覆盖四种紧急度（1 条已逾期、2 条 3 天内、6 条 14 天内、38 条远期）。
import { looksLikeNoise, makeMessageId, normalizeKind, toBeijingISO } from "../shared/message.js";

const SEED = 20261011;
const DAY_MS = 86400000;
export const DEFAULT_TOTAL = 273;
const WINDOW_DAYS = 30;

const GROUPS = [
  { name: "示例放行群", weight: 40 },
  { name: "示例年级群", weight: 22 },
  { name: "示例班级群", weight: 14 },
  { name: "电工电子实验课群", weight: 12 },
  { name: "示例通知群", weight: 12 },
];

const SENDERS = [
  "罗雨",
  "王浩",
  "李明",
  "张敏",
  "赵磊",
  "陈晨",
  "刘洋",
  "孙悦",
  "杨帆",
  "吴倩",
  "郑凯",
  "何静",
  "黄磊",
  "马超",
  "辅导员周老师",
  "陈倩",
  "示例学院学生会",
  "教务办张老师",
];

const CHATTER = [
  "哈哈哈哈今天食堂的饭是真的难吃，排了二十分钟",
  "有人一起去图书馆占座吗，四楼靠窗那排",
  "刚跑完步回来，操场人还挺多的，风也大",
  "这周高数作业有谁会第三题，求个讲解",
  "我明天可能迟到十分钟，帮我签个到哈",
  "谁有上学期电路分析的复习资料，求分享一下",
  "宿舍楼下的快递柜又满了，我的包裹取不出来",
  "周六打球的有吗，老操场南边那个场地",
  "刚刚路过西楼看到有人在拍毕业照，还挺好看",
  "今天降温好明显，出门记得加件外套",
  "笑死我了，物理实验又炸了一次，老师脸都黑了",
  "有没有人知道二食堂几点关门，想去吃夜宵",
  "我觉得这次期中考试的难度比去年高不少",
  "晚上一起去东门吃烧烤吧，我请客",
  "刚才在实验楼A305捡到一把伞，失主群里说一声",
  "图书馆四楼今天空调坏了，热得像蒸笼",
  "你们谁那里有多余的二极管，借我两个急用",
  "明天早八是概率论还是信号与系统，我记混了",
  "下午的课换到西楼203了，别跑错教室",
  "有没有同学周四想一起去看校队的篮球赛",
  "我刚把第三章习题做完了，需要参考的说一声",
  "今天宿舍检查到几点，我东西还没收拾完",
  "有人要一起拼单买打印纸吗，一箱更便宜",
  "贵州这天气真是一天过四季，早上穿外套中午光膀子",
  "求问成绩在哪里查，教务系统一直打不开",
  "老校区的银杏黄了，有空去拍两张照片",
  "刚才班级群里那条通知我没看到，谁能复述一下",
  "晚上复习到两点，第二天早八真的要命",
  "实验室的示波器又坏了一台，排队等吧",
  "有谁知道学生证丢了怎么补办，急用",
];

const CHATTER_TAILS = [
  "，你们觉得呢",
  "，真的服了",
  "，明天再说吧",
  "，有没有同感",
  "，我上次也是这样",
  "，太真实了",
  "，笑不活了",
  "，算了不说了",
  "，谁懂啊",
  "，反正我是没辙了",
  "，就这样吧",
  "，等会儿再聊",
  "，回头我问问学长",
  "，感觉要来不及了",
  "，那我也去",
  "，你们先忙",
];

// 半正式：有信息量但没到「要人办事」，不产生待办
const SEMI = [
  "关于下周实验课的分组，我先把名单列出来大家看看有没有意见",
  "这个学期的课程设计我想做智能小车，有没有人一起组队",
  "刚刚和老师确认过，作业可以交电子版，但要按班级打包",
  "我把课表整理成表格发到群文件了，大家可以下载看",
  "明天的实验要提前预习，老师会抽查提问，别空手去",
  "咱们班的班级群相册我建好了，照片可以直接传上去",
  "宿舍长会议定在周三晚上七点，一舍的活动室",
  "问了下学长，这门课期末是闭卷，重点是后面三章",
  "我把上学期的试卷拍照传到群相册了，供参考",
  "助教说答疑时间改到周四下午三点，在实验楼B210",
  "这周的班会主题是安全教育，各位准时到场就行",
  "实验室新到了一批万用表，旧的还能凑合用",
];

const NOISE_POOL = [
  "哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈",
  "1111111111111111",
  "收到收到，谢谢老师提醒！",
  "好的好的，我这就去办，放心",
  "。。。。。。。。。。。。。",
  "+++++++++++++++++",
  "啊啊啊啊啊啊啊啊啊啊啊啊啊",
  "对对对对对对对对对对对",
];

const TAILS = [
  "逾期不再受理，请相互转告。",
  "辛苦各位班委尽快落实，谢谢配合。",
  "如有疑问请在群里@我，或者直接到辅导员办公室问我。",
  "请各班班长汇总后统一提交，不要个人单独发送。",
  "事关每位同学，请务必按时完成，未完成的将通报班级。",
  "收到请回复，方便统计人数。",
];

// 43 条互不重复的通知模板：每条只出现一次，{d} 会被替换成「11月7日18点前」这类跟随锚点的说法。
// 「同一模板只用一次」保证不会出现并排两行一样的台账，跨群同主题也不会撞标题。
const NOTICE_BODIES = [
  "关于国家奖学金、励志奖学金评审材料提交的通知，请符合条件的同学准备成绩单和证明材料，{d}交至辅导员办公室",
  "关于开展宿舍安全隐患排查的通知，重点检查违规电器和私拉电线，请各寝室{d}完成自查并在群里报备",
  "关于本学期期中教学检查学生评教工作的通知，请各位同学登录教务系统完成评教，{d}后系统关闭",
  "关于全国大学生电子设计竞赛校内选拔报名的通知，每队三人，报名表请{d}提交到学院教务办",
  "关于图书馆借阅图书即将到期的提醒，请在{d}归还或续借，逾期将收取滞纳金",
  "关于开展实验室安全准入考试的通知，未通过考试者不得进入实验室，考试请{d}完成",
  "关于收取本学期班费的通知，每人200元，由生活委员统一登记，{d}交齐",
  "关于规范课堂考勤与请假流程的通知，请假条需在{d}提交辅导员审批",
  "关于学院运动会报名工作的通知，每班至少报3名运动员，名单{d}发到年级群",
  "关于评选优秀学生干部的通知，请有意愿的同学提交个人事迹材料，{d}截止",
  "关于四六级考试报名缴费的通知，{d}未缴费视为放弃报名",
  "关于选课系统开放时间的通知，退补选{d}截止后不再受理任何调整",
  "关于资助诚信教育主题班会的通知，请各班在班会后提交签到表，{d}交至辅导员办公室",
  "关于开展志愿服务时长录入的通知，请同学们及时补录未登记的服务记录，{d}截止",
  "关于开展心理健康普测的通知，请各位同学按班级统一时间完成线上问卷，{d}做完",
  "关于补考报名工作的通知，需要参加补考的同学请在{d}到教学系统提交申请",
  "关于清查学籍信息错误的通知，请各位{d}核对教务系统中的姓名与身份证号",
  "关于组织参加校园招聘会的通知，请毕业班同学{d}到就业中心报名并提交简历",
  "关于实验室设备借用登记的通知，借用示波器需在{d}提交登记表并签字确认",
  "关于本学期课程设计选题的通知，请各位{d}提交选题，逾期自行承担",
  "关于实训安排调整的通知，{d}起执行新课表，请各班统计有冲突的同学名单",
  "关于收取实验报告的通知，第三次实验报告请在{d}交至实验楼B210",
  "关于校运会志愿者招募的通知，请有意向的同学{d}到学生会办公室报名",
  "关于本学期助学金评定结果公示的通知，公示期至{d}，有异议请到辅导员办公室反馈",
  "关于班级素拓活动统计的通知，请各班统计参与名单，{d}报学院",
  "关于组织收看安全教育直播的通知，请同学们{d}完成观看并在群内打卡",
  "关于教室多媒体设备报修的通知，请各班统计损坏设备，{d}填报维修单",
  "关于普通话水平测试报名的通知，{d}截止报名，测试费由班长统一收取",
  "关于实验室消防安全演练的通知，全体同学请在{d}到实验楼B座集合参加演练",
  "关于统计同学返校情况的通知，请各位{d}反馈返程车次与到达时间",
  "关于组织参加创新创业训练计划立项的通知，申报书{d}提交到学院",
  "关于图书资料借阅证补办的通知，需要补办的同学{d}到图书馆一楼登记",
  "关于办理学生证火车票优惠卡的通知，请各班统计需要办理的同学，{d}上交",
  "关于学院开放实验室预约的通知，{d}预约下周实验时段，逾期不再安排",
  "关于收缴团费的通知，请各班团支书{d}收齐并登记",
  "关于运动会方阵彩排的通知，参与方阵的同学{d}到田径场集合彩排",
  "关于举办网络安全知识竞赛的通知，请同学们{d}在线答题完成报名",
  "关于教材退换的通知，需要退换教材的同学{d}交至教材科",
  "关于举办青春心向党主题征文的通知，请各班提交征文，{d}截止",
  "关于组织参加大学生物理竞赛的通知，参赛同学{d}到教学办登记并领取准考证",
  "关于开展电信诈骗防范宣传的通知，请各班{d}组织一次班级宣讲并上报签到表",
  "关于毕业实习材料归档的通知，实习鉴定表请在{d}交到学院办公室",
  "关于实验室门禁卡办理的通知，需要办理门禁卡的同学{d}提交申请并登记",
];

// 截止日分布（相对今天的天数）：1 条已逾期，4 条 14 天内，其余 38 条远期。
// 加上 5 条视频同款里的 2 条 3 天内 + 2 条 14 天内，最终四档为 1 / 2 / 6 / 38 = 47。
const NOTICE_DAYS = [-2, 6, 8, 10, 13, ...Array.from({ length: 38 }, (_, i) => 18 + i)];
const NOTICE_HOURS = [18, 24, 12, 17];

// 视频里的 5 条同款主题：标题与 constraints 措辞保持原样，日期按锚点顺延成自然说法。
function buildRequired(anchor) {
  const day = (offset) => dayISO(anchor, offset);
  const at = (offset, hour, minute = 0) =>
    toBeijingISO(anchor.midnight + offset * DAY_MS + hour * 3600000 + minute * 60000);
  return [
    {
      groupName: "示例放行群",
      sender: "陈倩",
      // 截止 +7 天（紫档）
      ts: at(-1, 8, 15),
      text: `各位同学：关于组织填写体测安全风险告知书（附件6）的通知，请各班以班级为单位组织填写，不漏一人、不能代签，${deadlinePhrase(day(7), 24)}交至陈倩老师处。`,
      attachment: null,
      meta: {
        video: true,
        title: "组织填写体测安全风险告知书（附件6）",
        deadline: day(7),
        constraints: ["以班级为单位组织填写", "不漏一人·不能代签", "交至陈倩老师处"],
      },
    },
    {
      groupName: "示例放行群",
      sender: "张敏",
      // 截止 +1 天（琥珀档）
      ts: at(-1, 10, 20),
      text: `@全体成员 第三章课后习题，请大家在${deadlinePhrase(day(1), 24)}提交到学习通，逾期不再收取，注意统一按学号命名。`,
      attachment: null,
      meta: {
        video: true,
        title: "提交第三章课后习题",
        deadline: day(1),
        constraints: ["学习通提交", "按学号命名"],
      },
    },
    {
      groupName: "示例年级群",
      sender: "示例学院学生会",
      // 会议本身 +3 天 19:30（琥珀档）
      ts: at(-2, 11, 40),
      text: `【通知】${momentPhrase(day(3), "19:30")}在西楼117召开学生会工作例会，每班推荐2名代表参加，请各班班长会前把名单报给学生会办公室。`,
      attachment: null,
      meta: {
        video: true,
        title: "学生会工作例会（每班2名代表）",
        deadline: day(3),
        constraints: ["西楼117·19:30", "每班推荐2名代表"],
      },
    },
    {
      groupName: "示例年级群",
      sender: "辅导员周老师",
      // 截止 +12 天（紫档）
      ts: at(-1, 14, 30),
      text: `关于2027年城乡居民基本医疗保险参保登记及缴费工作，请各班统计参保名单，${deadlinePhrase(day(12))}填好汇总表报学院，未参保的同学需要填写放弃承诺书。`,
      attachment: null,
      meta: {
        video: true,
        title: "2027年城乡居民医保参保登记及缴费",
        deadline: day(12),
        constraints: ["统计参保名单", "未参保需签放弃承诺书"],
      },
    },
    {
      groupName: "示例放行群",
      sender: "罗雨",
      ts: at(-1, 12, 11),
      text: "有人一起吃饭吗",
      attachment: null,
      meta: { video: true, title: "约饭（不应成为待办）", expectNoTodo: true },
    },
  ];
}

// ---------- 时间锚点 ----------

// 锚点 = 运行时今天的北京日历日；dayISO/文案都从它派生，演示里不会出现与当月脱节的死日期。
function anchorDay(now = Date.now()) {
  const iso = toBeijingISO(now) || "1970-01-01T00:00:00+08:00";
  const date = iso.slice(0, 10);
  return { iso, date, midnight: Date.parse(`${date}T00:00:00+08:00`) };
}

function dayISO(anchor, offsetDays) {
  return toBeijingISO(anchor.midnight + offsetDays * DAY_MS).slice(0, 10);
}

function monthDay(iso) {
  const [, month, day] = iso.split("-").map(Number);
  return `${month}月${day}日`;
}

// 「11月7日18点前」/「11月7日前」
function deadlinePhrase(iso, hour = 0) {
  return hour ? `${monthDay(iso)}${hour}点前` : `${monthDay(iso)}前`;
}

// 「11月2日19:30」：会议/考试这类具体时点，不是截止
function momentPhrase(iso, clock) {
  return `${monthDay(iso)}${clock}`;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length) % list.length];
}

function pickGroup(rand) {
  const total = GROUPS.reduce((s, g) => s + g.weight, 0);
  let point = rand() * total;
  for (const g of GROUPS) {
    point -= g.weight;
    if (point <= 0) return g.name;
  }
  return GROUPS[0].name;
}

// 填充消息配比（20 个一循环）：12 闲聊 / 4 半正式 / 4 噪声；通知单独排期，不参与这个循环
function fillerSlot(index) {
  const slot = index % 20;
  if (slot < 12) return "chatter";
  if (slot < 16) return "semi";
  return "noise";
}

export function generateMockMessages(count = DEFAULT_TOTAL, options = {}) {
  const anchor = anchorDay(options.now ?? Date.now());
  const required = buildRequired(anchor);
  const total = Math.max(required.length, Math.floor(Number(count) || DEFAULT_TOTAL));

  // 通知模板每条只出现一次，count 太小时从尾部砍
  const noticeCount = Math.max(0, Math.min(NOTICE_BODIES.length, total - required.length));
  const fillerCount = Math.max(0, total - required.length - noticeCount);
  const rand = mulberry32(options.seed ?? SEED);

  // 时间窗：最近 30 天。结束点固定在今天早上 9 点，保证同一天内多次生成逐字节一致
  // （可重复 seed、重复 npm run seed 产生同样的 273 条 id，dedupe 不会多出数据）
  const start = anchor.midnight - (WINDOW_DAYS - 1) * DAY_MS + 7.5 * 3600000;
  const end = anchor.midnight + 9 * 3600000;
  const step = (end - start) / Math.max(1, fillerCount + noticeCount + 1);

  const messages = [];
  const push = (item) => {
    const kind = normalizeKind(item.text, item.attachment);
    messages.push({
      id: makeMessageId(item.groupName, item.ts, item.sender, item.text),
      groupName: item.groupName,
      sender: item.sender,
      ts: item.ts,
      kind,
      text: item.text,
      attachment: item.attachment ?? null,
      source: "mock",
      noise: item.noise === undefined ? looksLikeNoise(item.text, kind) : item.noise,
      raw: item.attachment && !item.text.startsWith("【文件】") ? `【文件】${item.attachment.name}\n${item.text}` : item.text,
      ...(item.meta ? { meta: item.meta } : {}),
    });
  };

  for (let i = 0; i < fillerCount; i += 1) {
    const slot = fillerSlot(i);
    let text;
    let attachment = null;
    if (slot === "chatter") {
      text = pick(rand, CHATTER);
      if (rand() < 0.65) text += pick(rand, CHATTER_TAILS);
    } else if (slot === "semi") text = pick(rand, SEMI);
    else text = pick(rand, NOISE_POOL);

    if (i % 23 === 5) {
      attachment = {
        name: `附件${(i % 9) + 1}-${["名单汇总表", "告知书", "评分细则", "课表", "报名表"][i % 5]}.${i % 2 ? "pdf" : "xlsx"}`,
        size: null,
      };
      text = `【文件】${attachment.name}\n${text}`;
    } else if (i % 31 === 7) {
      text = `【图片】${text}`;
    }

    push({
      groupName: pickGroup(rand),
      sender: pick(rand, SENDERS),
      ts: toBeijingISO(Math.round(start + step * (i + 1) + (rand() - 0.5) * 1800000)),
      text,
      attachment,
    });
  }

  for (let i = 0; i < noticeCount; i += 1) {
    const deadlineDay = NOTICE_DAYS[i];
    const deadline = dayISO(anchor, deadlineDay);
    const hour = NOTICE_HOURS[i % NOTICE_HOURS.length];
    const body = NOTICE_BODIES[i].replace("{d}", deadlinePhrase(deadline, hour > 12 ? 24 : hour));
    const tail = TAILS[i % TAILS.length];
    const text = `【通知】${body}。${tail}`;
    // 通知发出时间落在截止之前，且不晚于「昨天」，群里不会出现未来消息
    const issueDay = Math.max(-(WINDOW_DAYS - 1), Math.min(-1, deadlineDay - 5));
    push({
      groupName: pickGroup(rand),
      sender: i % 4 === 0 ? "教务办张老师" : pick(rand, SENDERS),
      ts: toBeijingISO(anchor.midnight + issueDay * DAY_MS + (8 + (i % 9)) * 3600000 + 5 * 60000),
      text,
    });
  }

  for (const item of required) push(item);

  messages.sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : 1) : a.ts < b.ts ? -1 : 1));
  return messages;
}

export async function seedMessages(store, count = DEFAULT_TOTAL, options = {}) {
  if (!store || typeof store.addMessages !== "function") {
    throw new Error("seedMessages(store, count) 需要一个 store 实例");
  }
  const messages = generateMockMessages(count, options);
  const startedAt = toBeijingISO(Date.now());
  const result = await store.addMessages(messages);
  const run = await store.addRun({
    kind: "ingest",
    startedAt,
    provider: "mock",
    imported: result.imported,
    skipped: result.skipped,
  });
  return { runId: run.id, imported: result.imported, skipped: result.skipped, total: messages.length };
}

// 视频同款提示词的当前文本（日期跟随锚点，模块加载时算一次）
export const MOCK_REQUIRED_TEXTS = buildRequired(anchorDay()).map((m) => m.text);
export default generateMockMessages;
