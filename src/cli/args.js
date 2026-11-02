// CLI 共用：参数解析 + env 装载。只用 node 内置模块。
import { loadEnv } from "../config.js";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[body] = true;
      continue;
    }
    args[body] = next;
    i += 1;
  }
  return args;
}

export function resolveEnv(args = {}) {
  const env = loadEnv(process.cwd());
  if (args["data-dir"]) env.DATA_DIR = String(args["data-dir"]);
  return env;
}

export function usage(lines) {
  console.log(lines.join("\n"));
}

export function printKeyValues(title, pairs) {
  console.log(title);
  const width = Math.max(...pairs.map(([k]) => visualWidth(k)));
  for (const [key, value] of pairs) {
    console.log(`  ${key}${" ".repeat(Math.max(0, width - visualWidth(key)))}  ${value}`);
  }
}

function visualWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return width;
}
