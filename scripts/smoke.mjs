// 端到端验收：临时 DATA_DIR 起一个真实服务进程，按 SPEC §9 逐条断言。
// 失败要能一眼看出「期望 vs 实际」，所以每条断言都把两个值一起打出来。
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const START_TIMEOUT_MS = 30000;

let failures = 0;
let childLog = '';

function pass(no, text, expected, actual) {
  console.log(`PASS ${no}  ${text}`);
  console.log(`        期望 ${expected} · 实际 ${actual}`);
}

function fail(no, text, expected, actual) {
  failures += 1;
  console.log(`FAIL ${no}  ${text}`);
  console.log(`        期望： ${expected}`);
  console.log(`        实际： ${actual}`);
}

function check(no, text, condition, expected, actual) {
  if (condition) pass(no, text, expected, actual);
  else fail(no, text, expected, actual);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function request(origin, pathname, init) {
  const res = await fetch(origin + pathname, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function postJson(origin, pathname, payload) {
  return request(origin, pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
}

function patchJson(origin, pathname, payload) {
  return request(origin, pathname, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${childLog.slice(-2000)}`);
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务在 ${START_TIMEOUT_MS / 1000}s 内没起来\n${childLog.slice(-2000)}`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qq-todo-smoke-'));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    AUTH_TOKEN: '',
    PUBLIC_URL: '',
    LIVE_ENABLED: 'off',
    LLM_PROVIDER: 'stub',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  childLog = (childLog + chunk).slice(-8000);
});
child.stderr.on('data', (chunk) => {
  childLog = (childLog + chunk).slice(-8000);
});

const stopChild = async () => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
  ]);
  if (!exited) child.kill('SIGKILL');
};

try {
  console.log(`smoke: 数据目录 ${dataDir}，端口 ${port}\n`);
  await waitForHealth(origin, child);

  // 0. 先确认服务真的起来了（断言 8 的正式校验放在最后，保持 1→8 的输出顺序）
  const ready = await request(origin, '/api/health');
  check(
    '0',
    '服务可达（临时 DATA_DIR）',
    ready.status === 200,
    'GET /api/health → 200',
    `HTTP ${ready.status}`,
  );

  // 2. seed 220 条
  const seeded = await postJson(origin, '/api/seed', { count: 220 });
  check(
    '1',
    'POST /api/seed {count:220}',
    seeded.body?.imported >= 200,
    'imported >= 200',
    `imported = ${seeded.body?.imported}`,
  );

  // 3. 首次抽取
  const firstExtract = await postJson(origin, '/api/extract', {});
  const processed = Number(firstExtract.body?.processed ?? -1);
  const todosCreated = Number(firstExtract.body?.todosCreated ?? -1);
  check(
    '2a',
    'POST /api/extract 处理量',
    processed >= 150,
    'processed >= 150',
    `processed = ${processed}`,
  );
  check(
    '2b',
    'POST /api/extract 待办产出在合理区间',
    todosCreated >= 20 && todosCreated <= 120,
    '20 <= todosCreated <= 120',
    `todosCreated = ${todosCreated}`,
  );

  // 4. 待办字段质量
  const todoList = await request(origin, '/api/todos?status=pending&limit=200');
  const pendingItems = Array.isArray(todoList.body?.items) ? todoList.body.items : [];
  const withDeadline = pendingItems.filter((t) => typeof t.deadline === 'string' && t.deadline);
  const withConstraints = pendingItems.filter((t) => Array.isArray(t.constraints) && t.constraints.length >= 2);
  check(
    '3a',
    '待办里至少一条有 deadline',
    withDeadline.length >= 1,
    '>= 1 条 deadline 非空',
    `${withDeadline.length} 条（示例 ${JSON.stringify(withDeadline[0]?.deadline ?? null)}）`,
  );
  check(
    '3b',
    '待办里至少一条 constraints 数 >= 2',
    withConstraints.length >= 1,
    '>= 1 条 constraints.length >= 2',
    `${withConstraints.length} 条（示例 ${JSON.stringify(withConstraints[0]?.constraints ?? null)}）`,
  );

  // 5. 勾选完成
  const target = pendingItems[0] ?? null;
  let doneOk = false;
  let doneDetail = '没有可勾选的待办';
  if (target) {
    const patched = await patchJson(origin, `/api/todos/${encodeURIComponent(target.id)}`, { status: 'done' });
    doneOk = patched.body?.todo?.status === 'done';
    doneDetail = `PATCH ${target.id} → status = ${JSON.stringify(patched.body?.todo?.status ?? null)}`;
  }
  check('4a', 'PATCH /api/todos/:id {status:"done"}', doneOk, '200 且 todo.status === "done"', doneDetail);

  const statsAfter = await request(origin, '/api/stats');
  const doneCount = Number(statsAfter.body?.counts?.done ?? -1);
  check(
    '4b',
    'stats.counts.done 反映勾选结果',
    doneCount >= 1,
    'counts.done >= 1',
    `counts.done = ${doneCount}`,
  );

  // 6. 漏斗
  const funnel = statsAfter.body?.funnel ?? {};
  check(
    '5a',
    'stats.funnel.messagesProcessed',
    Number(funnel.messagesProcessed) >= 150,
    'messagesProcessed >= 150',
    `messagesProcessed = ${funnel.messagesProcessed}`,
  );
  check(
    '5b',
    'stats.funnel.todosKept',
    Number(funnel.todosKept) >= 20,
    'todosKept >= 20',
    `todosKept = ${funnel.todosKept}`,
  );

  // 7. 二次抽取幂等
  const before = Number(statsAfter.body?.counts?.todos ?? -1);
  await postJson(origin, '/api/extract', {});
  const statsAgain = await request(origin, '/api/stats');
  const after = Number(statsAgain.body?.counts?.todos ?? -1);
  check(
    '6',
    '二次 extract 后待办总数不增加',
    after <= before,
    `counts.todos <= ${before}`,
    `counts.todos = ${after}`,
  );

  // 8. mock 消息与 raw 回链
  const messages = await request(origin, '/api/messages?limit=200&noise=exclude');
  const pool = Array.isArray(messages.body?.items) ? messages.body.items : [];
  const picked = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  const textOk = typeof picked?.text === 'string' && picked.text.length >= 10;
  const rawOk = textOk && typeof picked?.raw === 'string' && picked.raw.includes(picked.text.slice(0, 10));
  check(
    '7a',
    'mock 消息 text 长度 >= 10',
    textOk,
    'text.length >= 10',
    `text.length = ${picked?.text?.length ?? 'null'}`,
  );
  check(
    '7b',
    'mock 消息 raw 含 text 前 10 字',
    rawOk,
    `raw 包含 ${JSON.stringify(String(picked?.text ?? '').slice(0, 10))}`,
    `raw = ${JSON.stringify(String(picked?.raw ?? '').slice(0, 60))}`,
  );

  // 8. 健康检查的正式断言
  const health = await request(origin, '/api/health');
  check(
    '8',
    'GET /api/health 返回 ok',
    health.status === 200 && health.body?.ok === true,
    '200 且 ok === true',
    `${health.status} 且 ok === ${JSON.stringify(health.body?.ok)}`,
  );
} catch (err) {
  failures += 1;
  console.log(`FAIL -  smoke 执行中断`);
  console.log(`        期望： 9 组断言全部跑完`);
  console.log(`        实际： ${err?.message ?? err}`);
  if (childLog) console.log(`\n---- 服务端输出 ----\n${childLog.slice(-2000)}`);
} finally {
  await stopChild();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

if (failures > 0) {
  console.log(`\nsmoke 失败：${failures} 项断言未通过（退出码 1）`);
  process.exit(1);
}
console.log('\nsmoke 通过：全部断言 OK（退出码 0）');
process.exit(0);
