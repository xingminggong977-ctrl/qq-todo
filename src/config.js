// 配置入口：.env 自己解析（20 行内），避免为了这点事引 dotenv。
import { readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  PORT: 7788,
  HOST: "0.0.0.0",
  HTTPS_PORT: 0,
  // 80 口只做 https 跳转；0 = 不监听。必须列进 DEFAULTS，否则 snapshot() 读不到（TLS 就这么丢过一次）
  REDIRECT_PORT: 0,
  // acme.sh 走 http-01 续期时，80 口要把 /.well-known/acme-challenge/* 从这目录读出来
  ACME_WEBROOT: "",
  TLS_CERT: "",
  TLS_KEY: "",
  // 备用域名证书（同机多域名按 SNI 选）；key 不进 DEFAULTS 就会被 snapshot() 丢掉
  TLS_ALT_CERT: "",
  TLS_ALT_KEY: "",
  DATA_DIR: "./data",
  PUBLIC_URL: "",
  AUTH_TOKEN: "",
  VERSION: "1.0.0",
  LLM_PROVIDER: "stub",
  LLM_BASE_URL: "https://api.openai.com/v1",
  LLM_API_KEY: "",
  LLM_MODEL: "gpt-4o-mini",
  LLM_TIMEOUT_MS: 90000,
  LLM_PRICE_IN: 0.14,
  LLM_PRICE_OUT: 0.28,
  LIVE_ENABLED: "off",
  NAPCAT_WS_URL: "ws://127.0.0.1:3001/",
  NAPCAT_ACCESS_TOKEN: "",
  GROUP_ALLOWLIST: "",
  OWNER_QQ: "",
  PRIVATE_ALIAS: "",
  LIVE_POLL_ENABLED: "off",
  LIVE_POLL_INTERVAL_SEC: 300,
  LIVE_POLL_MAX_PER_GROUP: 50,
  // 图片消息视觉识别：VISION_* 也必须列进 DEFAULTS，否则 snapshot() 读不到（VAPID 踩过这个坑）
  VISION_ENABLED: "on",
  VISION_MODEL: "qwen3-vl-plus",
  VISION_MAX_PER_RUN: 8,
  VISION_TIMEOUT_MS: 30000,
  // Web Push：snapshot() 只回白名单里的键，VAPID 不在这里就等于永远读不到
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  VAPID_SUBJECT: "mailto:admin@example.com",
  // 只读演示站开关：必须列进 DEFAULTS，否则 snapshot() 读不到（VAPID/VISION 踩过同一个坑）
  DEMO_ENABLED: "on",
  // 抽取出新待办后立刻推一条 QQ 提醒（on/off）；定时器每 10 分钟兜底
  NOTIFY_NEW_ON_EXTRACT: "on",
};

const NUMERIC = new Set([
  "PORT",
  "LLM_TIMEOUT_MS",
  "LLM_PRICE_IN",
  "LLM_PRICE_OUT",
  "LIVE_POLL_INTERVAL_SEC",
  "LIVE_POLL_MAX_PER_GROUP",
  "VISION_MAX_PER_RUN",
  "VISION_TIMEOUT_MS",
]);

function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

// 只认 KEY=VALUE 与 # 注释；行内注释会误伤 URL 里的 #，所以不做行内截断。
function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = stripQuotes(body.slice(eq + 1));
  }
  return out;
}

function snapshot() {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const raw = process.env[key];
    // 空字符串当成未设置：shell 里 export FOO= 不该挡住 .env 或默认值。
    const value = raw === undefined || raw === "" ? def : raw;
    if (typeof def === "number") {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : def;
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export function loadEnv(dir = process.cwd()) {
  let text = null;
  try {
    text = readFileSync(path.join(dir, ".env"), "utf8");
  } catch {
    text = null; // .env 不存在是常态，不是错误
  }
  if (text) {
    for (const [key, value] of Object.entries(parseEnvText(text))) {
      const current = process.env[key];
      if (current === undefined || current === "") process.env[key] = value;
    }
  }
  return snapshot();
}

export function resolveDataDir(env = {}) {
  const dir = env && env.DATA_DIR ? env.DATA_DIR : process.env.DATA_DIR || DEFAULTS.DATA_DIR;
  return path.resolve(process.cwd(), dir);
}

export default { DEFAULTS, loadEnv, resolveDataDir };
