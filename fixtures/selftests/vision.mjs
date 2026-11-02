// 自测⑮：图片消息视觉识别（describeImage）+ pipeline 接入（预算 / 静默降级 / 不改原文）。
// 视觉调用全程用注入的 fetchImpl 打桩，不连 DashScope；临时 DATA_DIR，不碰 仓库的 data/。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeImage } from "../../src/extract/vision.js";
import { createStubProvider } from "../../src/extract/provider.js";
import { runExtract } from "../../src/extract/pipeline.js";
import { createStore } from "../../src/store.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-vision-"));
const imgDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-vision-img-"));
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+p0hRAAAAAElFTkSuQmCC";

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const png = path.join(imgDir, "screen.png");
writeFileSync(png, Buffer.from(PNG_BASE64, "base64"));
const gif = path.join(imgDir, "anim.gif");
writeFileSync(gif, Buffer.from(PNG_BASE64, "base64"));
const huge = path.join(imgDir, "huge.png");
writeFileSync(huge, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
const missing = path.join(imgDir, "not-there.png");

const OPENAI_ENV = { LLM_PROVIDER: "openai", LLM_API_KEY: "test-key", VISION_MODEL: "qwen3-vl-plus", LLM_BASE_URL: "https://example.test/v1" };
const okFetch = (content = "通知：会议改到 119 → 14，10月12日24点前提交") => {
  const seen = { url: "", body: null, headers: null };
  const impl = async (url, init) => {
    seen.url = url;
    seen.body = JSON.parse(init.body);
    seen.headers = init.headers;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { impl, seen };
};

try {
  // ① 成功：读中文截图
  const ok1 = okFetch();
  const r1 = await describeImage(png, { env: OPENAI_ENV, fetchImpl: ok1.impl });
  check("成功：ok=true 且读出文字", r1.ok === true && r1.text.includes("119 → 14"), JSON.stringify(r1.text));
  check("成功：返回 model / chars", r1.model === "qwen3-vl-plus" && r1.chars === r1.text.length, `${r1.model} chars=${r1.chars}`);
  check("请求打到 <base>/chat/completions", ok1.seen.url === "https://example.test/v1/chat/completions", ok1.seen.url);
  check("请求体带模型与 data:image/png;base64 图片", ok1.seen.body?.model === "qwen3-vl-plus" && ok1.seen.body?.messages?.[0]?.content?.[1]?.image_url?.url.startsWith("data:image/png;base64,"), ok1.seen.body?.model);
  check("请求头带 Bearer key", String(ok1.seen.headers?.authorization || "").startsWith("Bearer "), ok1.seen.headers?.authorization);

  // ② 截断：输出 2000 字只留 1200
  const long = await describeImage(png, { env: OPENAI_ENV, fetchImpl: okFetch("通".repeat(2000)).impl });
  check("超长输出被截断到 1200 字", long.ok === true && long.truncated === true && long.text.length <= 1200 + 6, `len=${long.text.length}`);

  // ③ 超时：fetch 永不返回
  const t0 = Date.now();
  const timeout = await describeImage(png, { env: OPENAI_ENV, fetchImpl: () => new Promise(() => {}), timeoutMs: 60 });
  check("超时：ok=false 且 reason 含超时", timeout.ok === false && /超时/.test(timeout.reason), `${timeout.reason} ${Date.now() - t0}ms`);
  check("超时：不会挂死（<2s 返回）", Date.now() - t0 < 2000, `${Date.now() - t0}ms`);

  // ④ 超过 4MB
  const big = await describeImage(huge, { env: OPENAI_ENV, fetchImpl: okFetch().impl });
  check("超过 4MB：拒绝且不调用模型", big.ok === false && /4MB/.test(big.reason), big.reason);

  // ⑤ 后缀不支持
  const gifRes = await describeImage(gif, { env: OPENAI_ENV, fetchImpl: okFetch().impl });
  check("不支持的后缀被拒", gifRes.ok === false && /不支持/.test(gifRes.reason), gifRes.reason);

  // ⑥ stub 降级
  let called = 0;
  const stubRes = await describeImage(png, { env: { LLM_PROVIDER: "stub" }, fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; } });
  check("stub 降级为 provider-not-vision", stubRes.ok === false && stubRes.reason === "provider-not-vision", stubRes.reason);
  check("stub 不发起任何网络调用", called === 0, String(called));

  // ⑦ 关掉视觉 / 缺 key / 缺文件
  const offRes = await describeImage(png, { env: { ...OPENAI_ENV, VISION_ENABLED: "off" }, fetchImpl: okFetch().impl });
  check("VISION_ENABLED=off 直接跳过", offRes.ok === false && offRes.reason === "vision-disabled", offRes.reason);
  const noKey = await describeImage(png, { env: { LLM_PROVIDER: "openai" }, fetchImpl: okFetch().impl });
  check("缺 LLM_API_KEY 报 missing-api-key", noKey.ok === false && noKey.reason === "missing-api-key", noKey.reason);
  const noFile = await describeImage(missing, { env: OPENAI_ENV, fetchImpl: okFetch().impl });
  check("文件不存在给可读原因", noFile.ok === false && /文件不存在/.test(noFile.reason), noFile.reason);

  // ⑧ HTTP 错误 / JSON 坏 / 空内容
  const http500 = await describeImage(png, { env: OPENAI_ENV, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  check("HTTP 500 报状态码", http500.ok === false && /HTTP 500/.test(http500.reason), http500.reason);
  const badJson = await describeImage(png, { env: OPENAI_ENV, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected token <"); } }) });
  check("响应不是 JSON 也不抛", badJson.ok === false && /解析响应失败/.test(badJson.reason), badJson.reason);
  const emptyBody = await describeImage(png, { env: OPENAI_ENV, fetchImpl: okFetch("   ").impl });
  check("模型返回空内容报「返回内容为空」", emptyBody.ok === false && /返回内容为空/.test(emptyBody.reason), emptyBody.reason);
  const arrayContent = await describeImage(png, { env: OPENAI_ENV, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: [{ type: "text", text: "分段" }, { text: "内容" }] } }] }) }) });
  check("content 是数组时也能拼出文字", arrayContent.ok === true && arrayContent.text === "分段内容", JSON.stringify(arrayContent.text));

  // ⑨ 任何输入都不抛
  let threw = null;
  const weird = [];
  for (const input of [null, 123, undefined, png]) {
    try {
      weird.push(await describeImage(input, input === png ? { env: OPENAI_ENV, fetchImpl: null } : undefined));
    } catch (err) {
      threw = err;
      break;
    }
  }
  check("畸形入参一律返回对象、绝不抛", threw === null && weird.every((r) => r && r.ok === false), threw ? threw.message : `${weird.length} 次调用均为 ok:false`);

  // ⑩ pipeline 接入：预算 + 拼接 + 不改原文
  const shots = [0, 1, 2, 3, 4].map((i) => {
    const p = path.join(imgDir, `shot-${i}.png`);
    writeFileSync(p, Buffer.from(PNG_BASE64, "base64"));
    return p;
  });
  const store = createStore({ dataDir });
  const mk = (i, over = {}) => ({
    groupName: "示例年级群",
    sender: "陈倩",
    ts: `2026-10-11T09:${String(10 + i).padStart(2, "0")}:00+08:00`,
    text: `截图通知 ${i}：请看群里那张图`,
    imageFile: shots[i % shots.length],
    ...over,
  });
  const five = [0, 1, 2, 3, 4].map((i) => mk(i));
  await store.addMessages(five);
  check("store 保留了 imageFile", store.listMessages({ limit: 0 }).items.every((m) => shots.includes(m.imageFile)), "5/5");

  let visionCalls = 0;
  const budgetFetch = async () => {
    visionCalls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "校运会报名：10月12日 19:30 西楼117，每班推 2 名代表" } }] }) };
  };
  const seenTexts = [];
  const stub = createStubProvider();
  const spy = { ...stub, classify: async (msgs, ctx) => { for (const m of msgs) seenTexts.push(m.text); return stub.classify(msgs, ctx); } };
  const run = await runExtract({
    env: { ...OPENAI_ENV, VISION_MAX_PER_RUN: 2 },
    store,
    provider: spy,
    force: true,
    batchSize: 10,
    concurrency: 1,
    retryDelayMs: 10,
    visionFetch: budgetFetch,
  });
  check("预算生效：只识别 2 张", run.visionUsed === 2 && visionCalls === 2, `used=${run.visionUsed} calls=${visionCalls}`);
  check("超预算的记 visionSkipped", run.visionSkipped === 3, String(run.visionSkipped));
  check("没有失败计数", run.visionFailed === 0, String(run.visionFailed));
  const enriched = seenTexts.filter((t) => t.includes("【图片文字】"));
  check("送模型的内容带【图片文字】+读出的正文", enriched.length === 2 && enriched[0].includes("西楼117"), `enriched=${enriched.length}`);
  check("原文仍在标记之前", enriched[0].indexOf("截图通知") === 0, enriched[0].slice(0, 10));
  const stored = store.listMessages({ limit: 0 }).items;
  check("库里的 text 没被改写", stored.every((m) => /^截图通知 \d+：请看群里那张图$/.test(m.text)), stored[0].text.slice(0, 14));

  // ⑪ 视觉失败静默降级：不影响判定结果与 counts
  const quietDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-vision-quiet-"));
  try {
    const quiet = createStore({ dataDir: quietDir });
    await quiet.addMessages([0, 1].map((i) => mk(i)));
    const boom = await runExtract({
      env: { ...OPENAI_ENV, VISION_MAX_PER_RUN: 2 },
      store: quiet,
      provider: createStubProvider(),
      force: true,
      batchSize: 10,
      concurrency: 1,
      retryDelayMs: 10,
      visionFetch: async () => { throw new Error("ECONNRESET"); },
    });
    check("视觉抛错：run 正常结束、dropped 0、errors 0", boom.droppedCount === 0 && boom.errors.length === 0 && boom.visionFailed === 2, `dropped=${boom.droppedCount} errors=${boom.errors.length} failed=${boom.visionFailed}`);
    check("视觉抛错：判定照常产出（不只一条丢）", boom.coveredCount === 2, String(boom.coveredCount));
  } finally {
    rmSync(quietDir, { recursive: true, force: true });
  }

  // ⑪b 同一张图被多条消息引用：一次 run 只识别一次（缓存按路径）
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-vision-cache-"));
  try {
    const cached = createStore({ dataDir: cacheDir });
    await cached.addMessages([
      mk(0, { text: "同图通知甲" }),
      mk(1, { text: "同图通知乙", imageFile: shots[0] }),
    ]);
    let cacheCalls = 0;
    const cacheRun = await runExtract({
      env: { ...OPENAI_ENV, VISION_MAX_PER_RUN: 8 },
      store: cached,
      provider: createStubProvider(),
      force: true,
      batchSize: 10,
      concurrency: 1,
      retryDelayMs: 10,
      visionFetch: async () => {
        cacheCalls += 1;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "同一张图" } }] }) };
      },
    });
    check("同一路径只识别一次（缓存）", cacheCalls === 1 && cacheRun.visionUsed === 2, `calls=${cacheCalls} used=${cacheRun.visionUsed}`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }

  // ⑫ stub provider 跑图：整轮不浪费调用
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "qqdsh-a-vision-stub-"));
  try {
    const s2 = createStore({ dataDir: stubDir });
    await s2.addMessages([0, 1].map((i) => mk(i)));
    let netCalls = 0;
    const stubRun = await runExtract({
      env: { LLM_PROVIDER: "stub" },
      store: s2,
      provider: createStubProvider(),
      force: true,
      batchSize: 10,
      concurrency: 1,
      retryDelayMs: 10,
      visionFetch: async () => { netCalls += 1; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }) }; },
    });
    check("stub 跑图：全部记 skipped 且不发网络请求", stubRun.visionSkipped === 2 && stubRun.visionFailed === 0 && netCalls === 0, `skipped=${stubRun.visionSkipped} calls=${netCalls}`);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }

  console.log(fail === 0 ? `\nPASS=${pass} FAIL=0\n全部 PASS` : `\nPASS=${pass} FAIL=${fail}\n存在失败用例`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(imgDir, { recursive: true, force: true });
}
