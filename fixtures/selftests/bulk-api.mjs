// 批量改状态的 HTTP 端点：走真实 app（同进程），确认 401/400/上限与 stats 一起返回。
// 关键点：非法入参必须一条都不改——所以每个反例之后都回读状态。
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failures = 0;
let total = 0;
function check(no, text, condition, expected, actual) {
  total += 1;
  if (condition) {
    console.log(`PASS  ${no}  ${text}`);
    console.log(`        期望 ${expected} · 实际 ${actual}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${no}  ${text}`);
    console.log(`        期望： ${expected}`);
    console.log(`        实际： ${actual}`);
  }
}

const TOKEN = "tok_BULK_SECRET";
const dataDir = mkdtempSync(path.join(tmpdir(), "qq-todo-bulk-"));

process.env.DATA_DIR = dataDir;
process.env.AUTH_TOKEN = TOKEN;
process.env.LIVE_ENABLED = "off";
process.env.LIVE_POLL_ENABLED = "off";
process.env.LLM_PROVIDER = "stub";

const { loadEnv } = await import("../../src/config.js");
const { buildContext } = await import("../../src/server/deps.js");
const { createApp } = await import("../../src/server/app.js");

const env = loadEnv(process.cwd());
const { store, deps } = await buildContext(env);
const app = createApp({ env, store, deps, publicDir: path.join(process.cwd(), "public") });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function request(method, pathname, body, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    // 鉴权走 ?t=（cookie 是浏览器路径，脚本里用查询参数最直接）
    const target = token
      ? `${pathname}${pathname.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`
      : pathname;
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(raw.toString("utf8"));
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function statuses(ids) {
  const out = [];
  for (const id of ids) {
    const todo = await store.getTodo(id);
    out.push(todo ? todo.status : "missing");
  }
  return out.join("/");
}

try {
  console.log(`临时数据目录=${dataDir}，端口=${port}`);
  const seeded = await store.addTodos([
    { messageId: "m_bulk_1", title: "提交实验报告", deadline: "2026-11-10", source: { groupName: "计科2201班级群" } },
    { messageId: "m_bulk_2", title: "缴纳班费", deadline: "2026-11-12", source: { groupName: "计科2201班级群" } },
    { messageId: "m_bulk_3", title: "参加年级例会", source: { groupName: "示例年级群" } },
    { messageId: "m_bulk_4", title: "填写测评问卷", deadline: "2026-11-15", source: { groupName: "示例年级群" } },
  ]);
  const items = (await store.listTodos({ status: "pending", limit: 0 })).items;
  const ids = items.map((t) => t.id);
  console.log(`预置待办=${seeded.created}，pending=${ids.length}`);
  const [a, b, c, d] = ids;

  // ① 三条 pending 批量 done
  const bulk = await request("POST", "/api/todos/bulk", { ids: [a, b, c], status: "done" });
  console.log(`① ${bulk.status} ${JSON.stringify(bulk.json)}`);
  check(
    "1",
    "POST /api/todos/bulk 批量 done 返回 200 且 updated=3",
    bulk.status === 200 && bulk.json?.updated === 3 && bulk.json?.skipped === 0,
    "200 / updated=3 / skipped=0",
    `${bulk.status} / updated=${bulk.json?.updated} / skipped=${bulk.json?.skipped}`,
  );
  check(
    "2",
    "① 响应里带 stats，counts.done 同步为 3",
    bulk.json?.stats?.counts?.done === 3 && bulk.json?.stats?.counts?.pending === 1,
    "done=3、pending=1",
    `done=${bulk.json?.stats?.counts?.done}、pending=${bulk.json?.stats?.counts?.pending}`,
  );
  check("3", "① 三条真的落到 done", (await statuses([a, b, c])) === "done/done/done", "done/done/done", await statuses([a, b, c]));

  // ② 混入未知 id：skipped 计数，不抛
  const mixed = await request("POST", "/api/todos/bulk", { ids: [d, "t_not_exist_1", "t_not_exist_2"], status: "dismissed" });
  console.log(`② ${mixed.status} ${JSON.stringify(mixed.json).slice(0, 120)}`);
  check(
    "4",
    "② 未知 id 计入 skipped 且返回 200",
    mixed.status === 200 && mixed.json?.updated === 1 && mixed.json?.skipped === 2,
    "200 / updated=1 / skipped=2",
    `${mixed.status} / updated=${mixed.json?.updated} / skipped=${mixed.json?.skipped}`,
  );
  check("5", "② 存在的那条改成 dismissed", (await statuses([d])) === "dismissed", "dismissed", await statuses([d]));

  // ③ 非法 status：400 且一条都不改
  const before = await statuses([a, b, c, d]);
  const bad = await request("POST", "/api/todos/bulk", { ids: [a, b], status: "archived" });
  console.log(`③ ${bad.status} ${JSON.stringify(bad.json)}`);
  check(
    "6",
    "③ 非法 status 返回 400 bad_request",
    bad.status === 400 && bad.json?.error?.code === "bad_request",
    "400 bad_request",
    `${bad.status} ${bad.json?.error?.code}`,
  );
  check("7", "③ 抛错后一条都没被改", (await statuses([a, b, c, d])) === before, before, await statuses([a, b, c, d]));

  // ④ 空数组 / 缺 ids / 超上限
  const empty = await request("POST", "/api/todos/bulk", { ids: [], status: "done" });
  const missing = await request("POST", "/api/todos/bulk", { status: "done" });
  const tooMany = await request("POST", "/api/todos/bulk", {
    ids: Array.from({ length: 201 }, (_, i) => `t_${i}`),
    status: "done",
  });
  console.log(`④ empty=${empty.status} missing=${missing.status} tooMany=${tooMany.status} ${JSON.stringify(tooMany.json).slice(0, 100)}`);
  check(
    "8",
    "④ ids 为空数组返回 400",
    empty.status === 400 && empty.json?.error?.code === "bad_request",
    "400 bad_request",
    `${empty.status} ${empty.json?.error?.code}`,
  );
  check(
    "9",
    "④ 缺 ids 返回 400",
    missing.status === 400 && missing.json?.error?.code === "bad_request",
    "400 bad_request",
    `${missing.status} ${missing.json?.error?.code}`,
  );
  check(
    "10",
    "④ 超过 200 个 id 返回 400 too_many",
    tooMany.status === 400 && tooMany.json?.error?.code === "too_many",
    "400 too_many",
    `${tooMany.status} ${tooMany.json?.error?.code}`,
  );

  // ⑤ 鉴权：无 token / 错 token → 401；GET 该路径 → 405
  const noToken = await request("POST", "/api/todos/bulk", { ids: [a], status: "pending" }, "");
  const wrongToken = await request("POST", "/api/todos/bulk", { ids: [a], status: "pending" }, "tok_wrong");
  const getRes = await request("GET", "/api/todos/bulk");
  console.log(`⑤ noToken=${noToken.status} wrongToken=${wrongToken.status} get=${getRes.status} ${JSON.stringify(getRes.json)}`);
  check("11", "⑤ 无 token 返回 401", noToken.status === 401, "401", String(noToken.status));
  check("12", "⑤ 错 token 返回 401", wrongToken.status === 401, "401", String(wrongToken.status));
  check(
    "13",
    // 路由按「方法 + 正则」逐条匹配：GET /api/todos/bulk 会先落进 GET /api/todos/:id，把 bulk 当成 id 去查
    "⑤ GET /api/todos/bulk 不会被当成批量接口（落到 :id 路由，404 not_found）",
    getRes.status === 404 && getRes.json?.error?.code === "not_found",
    "404 not_found",
    `${getRes.status} ${getRes.json?.error?.code}`,
  );
  check("14", "⑤ 401 之后状态没被动过", (await statuses([a])) === "done", "done", await statuses([a]));

  // ⑥ CSV 的「判定依据」也压成单行（含逗号/引号/换行时仍 8 列）
  await store.addTodos([
    {
      messageId: "m_bulk_reason",
      title: '开会, 带"纪要"',
      deadline: "2026-11-20",
      reason: '命中【通知】\n含,逗号"引号"\n和换行',
      source: { groupName: "示例年级群" },
    },
  ]);
  const csv = await request("GET", `/api/export.csv?t=${TOKEN}`);
  const text = csv.raw.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split("\r\n").filter((l) => l.length > 0);
  const dirty = lines.find((l) => l.includes('开会, 带""纪要""'));
  console.log(`⑥ ${csv.status} 记录数=${lines.length - 1} 脏标题行=${JSON.stringify(dirty)}`);
  check(
    "15",
    "⑥ 判定依据里的换行被压成空格（整张表无裸换行）",
    Boolean(dirty) && dirty.includes("命中【通知】 含,逗号\"\"引号\"\" 和换行"),
    'reason 单行且引号翻倍',
    dirty ?? "未找到该行",
  );
  check(
    "16",
    "⑥ 被压平后仍然是 8 列（逗号/引号未切错列）",
    // 用最小解析器数一下：被引号包住的逗号不该被算成列分隔
    (() => {
      const cells = [];
      let cell = "";
      let quoted = false;
      for (let i = 0; i < (dirty ?? "").length; i += 1) {
        const ch = dirty[i];
        if (quoted) {
          if (ch === '"') {
            if (dirty[i + 1] === '"') {
              cell += '"';
              i += 1;
            } else quoted = false;
          } else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") {
          cells.push(cell);
          cell = "";
        } else cell += ch;
      }
      cells.push(cell);
      return cells.length === 8;
    })(),
    "8 列",
    `${(dirty ?? "").split(",").length} 个逗号切分`,
  );
  check(
    "17",
    "⑥ CSV 仍是 UTF-8 BOM 开头",
    [...csv.raw.subarray(0, 3)].map((x) => x.toString(16).padStart(2, "0")).join(" ") === "ef bb bf",
    "ef bb bf",
    [...csv.raw.subarray(0, 3)].map((x) => x.toString(16).padStart(2, "0")).join(" "),
  );
  check(
    "18",
    "⑥ 无 token 拉 CSV 返回 401",
    (await request("GET", "/api/export.csv", undefined, "")).status === 401,
    "401",
    String((await request("GET", "/api/export.csv", undefined, "")).status),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\nPASS=${total - failures} FAIL=${failures}`);
if (failures === 0) console.log("全部 PASS");
process.exit(failures === 0 ? 0 : 1);
