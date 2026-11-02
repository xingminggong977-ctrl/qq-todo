// 演示站自测：真实 store 与演示 store 必须彻底隔离，且演示接口只读。
// 跑法：node fixtures/selftests/demo-readonly.mjs
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PASS = [];
const FAIL = [];

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

function request(port, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'qq-todo-demo-'));

process.env.DATA_DIR = dataDir;
process.env.AUTH_TOKEN = 'tok_DEMO_SECRET';
process.env.LIVE_ENABLED = 'off';
process.env.LIVE_POLL_ENABLED = 'off';
process.env.LLM_PROVIDER = 'stub';

const { loadEnv } = await import('../../src/config.js');
const { buildContext } = await import('../../src/server/deps.js');
const { createApp } = await import('../../src/server/app.js');
const { createDemo } = await import('../../src/server/demo.js');

const env = loadEnv(process.cwd());
const { store, deps } = await buildContext(env);
const realBefore = store.counts();

const app = createApp({ env, store, deps, publicDir: path.join(process.cwd(), 'public') });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`临时实例：http://127.0.0.1:${port}（DATA_DIR=${dataDir}，真实库 counts=${JSON.stringify(realBefore)}）`);

// ① 首次访问自动建库
const demoStoreJson = path.join(dataDir, 'demo', 'store.json');
const existedBefore = existsSync(demoStoreJson);
const statsRes = await request(port, 'GET', '/demo/api/stats');
check(
  '1',
  '首次访问 /demo/api/stats 自动建库',
  existedBefore === false && existsSync(demoStoreJson) && statsRes.status === 200,
  '请求前无 demo/store.json，请求后存在且 200',
  `请求前 ${existedBefore ? '已存在' : '不存在'}，请求后 ${existsSync(demoStoreJson) ? '已生成' : '仍缺失'}，状态 ${statsRes.status}`,
);

// ② 演示数据是 stub 的固定产出
const stats = JSON.parse(statsRes.text);
check(
  '2',
  '/demo/api/stats 返回 273 条消息 / 47 件待办',
  stats.counts?.messages === 273 && stats.counts?.todos === 47,
  'messages=273、todos=47',
  `messages=${stats.counts?.messages}、todos=${stats.counts?.todos}、provider=${stats.provider}`,
);

// ③ 只读：任何写方法都是 405 read_only
const postRes = await request(port, 'POST', '/demo/api/todos/x', '{}');
let postBody = {};
try {
  postBody = JSON.parse(postRes.text);
} catch {
  postBody = {};
}
check(
  '3',
  'POST /demo/api/todos/x 返回 405 read_only',
  postRes.status === 405 && postBody.error?.code === 'read_only',
  '405 + {"error":{"code":"read_only",...}}',
  `${postRes.status} + ${postRes.text.slice(0, 80)}`,
);

// ④ 真实库一个字节都没动
const realAfter = store.counts();
const realStoreFile = path.join(dataDir, 'store.json');
const realTouched = existsSync(realStoreFile);
check(
  '4',
  '演示请求后真实 store counts 不变',
  JSON.stringify(realAfter) === JSON.stringify(realBefore) && realTouched === false,
  `${JSON.stringify(realBefore)}，且不产生真实 store.json`,
  `${JSON.stringify(realAfter)}，真实 store.json ${realTouched ? '被写入' : '未创建'}`,
);

// ⑤ 并发两次首访只建一次库（用独立实例，避免复用 ① 已建好的库）
const demo2Dir = path.join(dataDir, 'demo2');
const built = [];
const demo2 = createDemo({
  env: { ...env, DATA_DIR: path.join(dataDir, 'demo2root') },
  log: { log: (msg) => built.push(msg) },
});
const [s1, s2] = await Promise.all([demo2.ensure(), demo2.ensure()]);
const json2 = path.join(dataDir, 'demo2root', 'demo', 'store.json');
const mtime1 = statSync(json2).mtimeMs;
await new Promise((r) => setTimeout(r, 120));
const sameInstance = s1 === s2;
check(
  '5',
  '并发两次首访只建一次库',
  sameInstance && built.length === 1 && statSync(json2).mtimeMs === mtime1,
  '同一 store 实例、只打一行建库日志、store.json 不被重写',
  `同一实例=${sameInstance}、建库日志 ${built.length} 行、mtime ${statSync(json2).mtimeMs === mtime1 ? '未变' : '变了'}`,
);

// ⑥ 演示页与静态资源能从 /demo/ 前缀取到（与 public/index.html 的相对路径对齐）
const page = await request(port, 'GET', '/demo/');
const css = await request(port, 'GET', '/demo/styles.css');
check(
  '6',
  '/demo/ 与 /demo/styles.css 可直接访问（不需要 token）',
  page.status === 200 &&
    String(page.headers['content-type']).includes('text/html') &&
    css.status === 200 &&
    String(css.headers['content-type']).includes('text/css'),
  '200 text/html + 200 text/css',
  `${page.status} ${String(page.headers['content-type']).split(';')[0]} + ${css.status} ${String(css.headers['content-type']).split(';')[0]}`,
);

await new Promise((resolve) => server.close(resolve));
rmSync(dataDir, { recursive: true, force: true });

console.log('');
if (FAIL.length) {
  console.log(`demo-readonly 失败：${FAIL.length} 项未通过（${FAIL.join(', ')}）`);
  process.exitCode = 1;
} else {
  console.log(`demo-readonly 通过：${PASS.length} 项断言全部 OK`);
}
