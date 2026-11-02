#!/usr/bin/env node
// 恢复演练：把一份备份真的解包、真的起一个临时实例、用 /api/stats 对账。
// 「备份文件能解开」不等于「备份能跑」，所以这里不解析文件了事，而是让服务自己读出 counts 来。
//
// 用法：node deploy/restore-drill.mjs <备份.tar.gz> [--port 7800]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '..', 'src', 'server', 'index.js');

const backupFile = process.argv[2];
const portArgIndex = process.argv.indexOf('--port');
const fixedPort = portArgIndex > -1 ? Number(process.argv[portArgIndex + 1]) : 0;

if (!backupFile) {
  console.error('用法：node deploy/restore-drill.mjs <备份.tar.gz> [--port 7800]');
  process.exit(2);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  cleanup();
  process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'qq-todo-drill-'));
let child = null;

function cleanup() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 1500).unref();
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForStats(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '无响应';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`临时实例 ${timeoutMs}ms 内没有就绪：${lastError}`);
}

// 1) 解包
if (!existsSync(backupFile)) fail(`备份文件不存在：${backupFile}`);
const untar = spawnSync('tar', ['-xzf', backupFile, '-C', workDir], { encoding: 'utf8' });
if (untar.status !== 0) fail(`解包失败：${untar.stderr || untar.status}`);

const restoredStore = path.join(workDir, 'store.json');
if (!existsSync(restoredStore)) fail('解包后没有 store.json');

let backupState;
try {
  backupState = JSON.parse(readFileSync(restoredStore, 'utf8'));
} catch (err) {
  fail(`解包出来的 store.json 不是合法 JSON：${err.message}`);
}

// 2) 起临时实例（AUTH_TOKEN 置空只为了让演练脚本免 token，实例只监听回环）
const port = fixedPort || (await freePort());
child = spawn(process.execPath, [serverEntry], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: workDir,
    AUTH_TOKEN: '',
    LIVE_ENABLED: 'off',
    LLM_PROVIDER: 'stub',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (chunk) => {
  childLog += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  childLog += chunk.toString();
});

let stats;
try {
  stats = await waitForStats(port);
} catch (err) {
  fail(`${err.message}\n--- 子进程输出 ---\n${childLog.slice(-800)}`);
}

// 3) 对账：服务自报的 counts 必须与备份文件里的数组长度逐项相等
const backupCounts = {
  messages: backupState.messages.length,
  todos: backupState.todos.length,
  pending: backupState.todos.filter((todo) => todo.status === 'pending').length,
  done: backupState.todos.filter((todo) => todo.status === 'done').length,
};
const liveCounts = stats?.counts ?? {};
const diff = ['messages', 'todos', 'pending', 'done'].filter(
  (key) => Number(liveCounts[key]) !== backupCounts[key],
);

console.log(`PASS 解包目录        ${workDir}`);
console.log(`PASS 临时实例        http://127.0.0.1:${port}/api/stats 已响应`);
console.log(
  `PASS 备份内计数      messages=${backupCounts.messages} todos=${backupCounts.todos} pending=${backupCounts.pending} done=${backupCounts.done}`,
);
console.log(
  `PASS 服务自报计数    messages=${liveCounts.messages} todos=${liveCounts.todos} pending=${liveCounts.pending} done=${liveCounts.done}`,
);

cleanup();
if (diff.length > 0) {
  console.error(`FAIL counts 不一致，字段：${diff.join(', ')}`);
  process.exit(1);
}
console.log('PASS 恢复演练        counts 逐项一致，备份可用于真实恢复');
