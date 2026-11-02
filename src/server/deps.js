// 唯一的接线处：A/D 的真实模块只在这里 import。
// 任何一方改了签名，只改这一个文件，server 的其余部分不受影响。
import { resolveDataDir } from '../config.js';
import { createStore } from '../store.js';
import { parseQqExport } from '../ingest/parser.js';
import { seedMessages } from '../ingest/mock.js';
import { runExtract } from '../extract/pipeline.js';
import { startLive } from '../live/napcat.js';

export { startLive };

export async function buildContext(env) {
  const store = await createStore({
    dataDir: resolveDataDir(env),
    provider: env.LLM_PROVIDER,
  });

  let live = null;
  const deps = {
    ingest: { parse: (filename, content, options) => parseQqExport(filename, content, options) },
    seed: { run: (count) => seedMessages(store, count) },
    extract: { run: (options) => runExtract(options) },
    live: () => live,
    setLive: (instance) => {
      live = instance;
    },
  };

  return { store, deps };
}
