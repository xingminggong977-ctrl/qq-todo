// 演示站的三个开关自测：DEMO_ENABLED、启动预热、mock 指纹过期重建。
// 跑法：node fixtures/selftests/demo-switches.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PASS = [];
const FAIL = [];
const ROOT = process.cwd();

function check(no, title, ok, expected, actual) {
  if (ok) {
    PASS.push(no);
    console.log(`PASS ${no} ${title}`);
    console.log(`        期望 ${expected} · 实际 ${actual}`);
  } else {
    FAIL.push(no);
    console.log(`FAIL ${no} ${title}`);
    console.log(`  期望：${expected}`);
    console.log(`  实际：${actual}`);
  }
}

function request(port, reqPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(port, predicate, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function startServer(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_TOKEN: '',
      LIVE_ENABLED: 'off',
      LIVE_POLL_ENABLED: 'off',
      LLM_PROVIDER: 'stub',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const ready = await waitFor(port, async () => (await request(port, '/api/health')).status === 200);
  if (!ready) throw new Error(`服务没起来：\n${output}`);
  return { port, child, output: () => output };
}

async function stopServer(server) {
  server.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill('SIGKILL');
      resolve();
    }, 5000);
    server.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const workDir = mkdtempSync(path.join(tmpdir(), 'qq-todo-demo-switch-'));

// ① DEMO_ENABLED=off：/demo 与 /demo/api/* 都是 404，且不建演示库
{
  const dataDir = path.join(workDir, 'off');
  const server = await startServer({ DATA_DIR: dataDir, DEMO_ENABLED: 'off' });
  const page = await request(server.port, '/demo/');
  const api = await request(server.port, '/demo/api/stats');
  let code = '';
  try {
    code = JSON.parse(api.text).error?.code ?? '';
  } catch {
    code = '(非 JSON)';
  }
  const demoDir = existsSync(path.join(dataDir, 'demo'));
  check(
    '1',
    'DEMO_ENABLED=off 时 /demo/ 与 /demo/api/stats 都是 404',
    page.status === 404 && api.status === 404 && code === 'not_found',
    '404 + 404 + error.code=not_found',
    `${page.status} + ${api.status} + error.code=${code}`,
  );
  check(
    '2',
    'DEMO_ENABLED=off 时不会创建演示库目录',
    demoDir === false,
    `${path.join(dataDir, 'demo')} 不存在`,
    demoDir ? '目录被创建了' : '目录不存在',
  );
  await stopServer(server);
}

// ② DEMO_ENABLED=on：启动预热（一次请求都不发，演示库自己长出来）+ 照旧可访问
{
  const dataDir = path.join(workDir, 'on');
  const server = await startServer({ DATA_DIR: dataDir });
  const demoStoreFile = path.join(dataDir, 'demo', 'store.json');
  const prewarmed = await waitFor(server.port, async () => existsSync(demoStoreFile), 20000);
  check(
    '3',
    '启动 1.5s 后自动预热演示库（未发任何 /demo 请求）',
    prewarmed,
    'demo/store.json 在无人访问时出现',
    prewarmed ? '已生成' : '仍是缺失',
  );
  const stats = JSON.parse((await request(server.port, '/demo/api/stats')).text);
  const page = await request(server.port, '/demo/');
  check(
    '4',
    'DEMO_ENABLED=on 时 /demo/ 与 /demo/api/stats 照旧 200',
    page.status === 200 && stats.counts?.messages === 273 && stats.counts?.todos === 47,
    '200 + messages=273 / todos=47',
    `${page.status} + messages=${stats.counts?.messages} / todos=${stats.counts?.todos}`,
  );

  const meta = JSON.parse(readFileSync(path.join(dataDir, 'demo', 'meta.json'), 'utf8'));
  check(
    '5',
    '演示库写出 meta.json 指纹',
    typeof meta.mockVersion === 'string' && meta.mockVersion.length === 12 && meta.messages === 273,
    'mockVersion 为 12 位 sha1 前缀、messages=273',
    `mockVersion=${meta.mockVersion}, messages=${meta.messages}, todos=${meta.todos}`,
  );
  await stopServer(server);

  // ③ 篡改指纹后重启：应触发整库重建，数据仍是 273/47
  const metaFile = path.join(dataDir, 'demo', 'meta.json');
  const tampered = { ...meta, mockVersion: 'deadbeef0000' };
  writeFileSync(metaFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

  const restarted = await startServer({ DATA_DIR: dataDir });
  const rebuilt = JSON.parse((await request(restarted.port, '/demo/api/stats')).text);
  const out = restarted.output();
  const metaAfter = JSON.parse(readFileSync(metaFile, 'utf8'));
  check(
    '6',
    '篡改 meta.json 指纹后重启 → 触发重建且数据仍是 273/47',
    out.includes('演示库与当前 mock 数据不一致') &&
      rebuilt.counts?.messages === 273 &&
      rebuilt.counts?.todos === 47 &&
      metaAfter.mockVersion !== 'deadbeef0000',
    '日志含「演示库与当前 mock 数据不一致，重建」、273/47、meta 指纹被改写',
    `日志${out.includes('演示库与当前 mock 数据不一致') ? '有' : '没有'}重建提示、messages=${rebuilt.counts?.messages}/todos=${rebuilt.counts?.todos}、mockVersion ${metaAfter.mockVersion === 'deadbeef0000' ? '未更新' : '已更新为 ' + metaAfter.mockVersion}`,
  );
  await stopServer(restarted);
}

rmSync(workDir, { recursive: true, force: true });

console.log('');
if (FAIL.length) {
  console.log(`demo-switches 失败：${FAIL.length} 项未通过（${FAIL.join(', ')}）`);
  process.exitCode = 1;
} else {
  console.log(`demo-switches 通过：${PASS.length} 项断言全部 OK`);
}
