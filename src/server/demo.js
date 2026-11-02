// 只读在线演示：给开源项目来访者一个不用部署就能点开看的门面。
// 三件事必须成立：① 演示数据独立在 <DATA_DIR>/demo，绝不写真实库；② 只读；③ 零成本离线可跑（stub provider）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../config.js';
import { createStore } from '../store.js';
import { generateMockMessages } from '../ingest/mock.js';
import { runExtract } from '../extract/pipeline.js';
import { createStubProvider } from '../extract/provider.js';
import { createApi } from './api.js';
import { createStaticHandler } from './static.js';
import { HttpError } from './http.js';

const PREFIX = '/demo';
const META_FILE = 'meta.json';

// 指纹只取「抽取前就已确定」的输入：消息条数 + 每条文本。
// 用抽取后的 title 也算得出来，但那时候库已经建完了；重建决策必须提前做。
export function mockFingerprint(messages) {
  const hash = createHash('sha1');
  hash.update(String(messages.length));
  for (const item of messages) hash.update(`\u0000${item.text ?? ''}`);
  return hash.digest('hex').slice(0, 12);
}

// 演示库的依赖全部是空壳：POST/PATCH 在入口就被 405 挡住，这里只保证 GET 路由不炸
function inertDeps() {
  return {
    ingest: { parse: () => ({ messages: [], warnings: [], groups: [] }) },
    seed: { run: async () => ({ runId: 'demo', imported: 0 }) },
    extract: { run: async () => ({}) },
    live: () => null,
    push: () => null,
    setLive: () => {},
  };
}

export function createDemo({ env = {}, log = console } = {}) {
  const dataDir = path.join(resolveDataDir(env), 'demo');
  const serveStatic = createStaticHandler({
    dir: fileURLToPath(new URL('../../public/', import.meta.url)),
  });

  let demoStore = null;
  let demoApi = null;
  let building = null;

  async function build() {
    const messages = generateMockMessages();
    const mockVersion = mockFingerprint(messages);
    const metaFile = path.join(dataDir, META_FILE);

    let meta = null;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch {
      meta = null; // 没有 meta 或内容损坏，都按「过期」处理
    }
    if (existsSync(path.join(dataDir, 'store.json')) && meta?.mockVersion !== mockVersion) {
      log.log?.('[demo] 演示库与当前 mock 数据不一致，重建');
      rmSync(dataDir, { recursive: true, force: true });
    }

    mkdirSync(dataDir, { recursive: true });
    const store = await createStore({ dataDir, provider: 'stub' });
    const hasData = existsSync(path.join(dataDir, 'store.json'));
    if (!hasData || store.counts().messages === 0) {
      await store.addMessages(messages);
      // 演示库永远用 stub：用户配的 openai 不该因为有人点开 /demo 就被扣钱
      await runExtract({
        env: { ...env, LLM_PROVIDER: 'stub', VISION_ENABLED: 'off' },
        store,
        provider: createStubProvider(),
      });
      await store.flush?.();
      log.log?.(`[demo] 演示库已生成：${store.counts().messages} 条消息 / ${store.counts().todos} 件待办（${dataDir}）`);
    }
    writeFileSync(
      metaFile,
      `${JSON.stringify(
        { mockVersion, builtAt: new Date().toISOString(), messages: store.counts().messages, todos: store.counts().todos },
        null,
        2,
      )}\n`,
      'utf8',
    );
    demoStore = store;
    demoApi = createApi({ env, store, deps: inertDeps() });
    return store;
  }

  // 并发首访只能建一次库：缓存的是 Promise，不是结果
  function ensure() {
    if (demoStore) return Promise.resolve(demoStore);
    if (building) return building;
    building = build().catch((err) => {
      building = null;
      throw err;
    });
    return building;
  }

  async function handle({ req, res, url }) {
    const { pathname, search } = url;

    if (pathname === PREFIX) {
      res.writeHead(302, { location: `${PREFIX}/${search}`, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (pathname === `${PREFIX}/api` || pathname.startsWith(`${PREFIX}/api/`)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'read_only', '演示模式只读');
      }
      await ensure();
      const inner = new URL(url.href);
      inner.pathname = pathname.slice(PREFIX.length) || '/api';
      res.setHeader('cache-control', 'no-store');
      await demoApi({ req, res, url: inner });
      return;
    }

    // 页面与静态资源：/demo/app.js → public/app.js。
    // 这样 public/index.html 里的相对路径（./app.js、./styles.css）不用为演示改一行。
    const rest = pathname.slice(PREFIX.length) || '/';
    const target = rest === '/' ? '/index.html' : rest;
    await serveStatic(req, res, target);
  }

  return { handle, ensure, dataDir, store: () => demoStore };
}
