// 开源门禁：仓库里不许出现真实标识（域名 / IP / AUTH_TOKEN / 真实 QQ 号 / 本机路径 / 密钥）。
// 只用 node 内置模块，Windows 与 Linux 都能跑：npm run check-secrets 或 node scripts/check-secrets.mjs
//
// 扫描对象：git 会跟踪的文件（有 .git 时用 `git ls-files`，否则按目录白名单遍历），
// 这样 .env、data/ 之类本来就不进版本库的东西不会误报。
//
// 注意：规则里的真实标识必须**拆成两段再拼**——本文件本身也在 `git grep` 硬门禁
// 的扫描范围里（README 的验收清单会直接 grep 那串域名），写完整字面量会让门禁命中自己。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const join = (...parts) => parts.join("");
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = (parts, flags = "") => new RegExp(esc(join(...parts)), flags);

// 每条规则都是「必须为 0 命中」的硬门禁。改这里等于改门禁，PR 里请说明理由。
const RULES = [
  { id: "domain", re: re(["prim", "nex.cn"], "i"), why: "真实域名" },
  { id: "ip-1", re: re(["47.110", ".162", ".144"]), why: "真实服务器 IP" },
  { id: "ip-2", re: re(["114.55", ".63", ".161"]), why: "真实服务器 IP" },
  { id: "ip-3", re: re(["172.28", ".205", ".94"]), why: "真实内网 IP" },
  { id: "ip-4", re: re(["10.214", ".59", ".80"]), why: "真实内网 IP" },
  // sslip.io 之类的通配 DNS 会把 IP 写成 1-2-3-4.sslip.io，点分规则抓不到
  { id: "ip-1-dashed", re: re(["47-110", "-162", "-144"]), why: "真实服务器 IP（虚线写法）" },
  { id: "ip-2-dashed", re: re(["114-55", "-63", "-161"]), why: "真实服务器 IP（虚线写法）" },
  { id: "auth-token", re: re(["f51f39", "ef70c2baa8917394bf07cd1e3d"], "i"), why: "真实 AUTH_TOKEN" },
  { id: "qq-owner", re: re(["8227", "27259"]), why: "真实 owner QQ 号" },
  { id: "qq-bot", re: re(["3638", "134527"]), why: "真实机器人 QQ 号" },
  { id: "qq-group", re: re(["1129", "146357"]), why: "真实群号" },
  { id: "path-win", re: /C:\\+Users\\+lenovo/i, why: "本机用户名路径" },
  { id: "path-repo", re: /F:\\+qq-dsh/i, why: "本机仓库路径" },
  { id: "aliyun-ak", re: /\bLTAI[A-Za-z0-9]{8,}/, why: "阿里云 AccessKey" },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/, why: "模型 API Key" },
  { id: "pem", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, why: "私钥块" },
];

// 这些路径天然包含示例串或规则本身，跳过扫描。
const SKIP_PATHS = ["scripts/check-secrets.mjs", ".git/", "node_modules/", ".artifacts/"];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mp3|db|sqlite)$/i;

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}

const tracked = trackedFiles();
const source = tracked ? "git ls-files" : "目录遍历（未 git init）";
const files = (tracked ?? walk(ROOT)).filter(
  (rel) => !SKIP_PATHS.some((s) => rel === s || rel.startsWith(s)) && !BINARY_EXT.test(rel),
);

const hits = [];
let scanned = 0;
for (const rel of files) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of RULES) {
      if (rule.re.test(lines[i])) {
        hits.push({ rel, line: i + 1, id: rule.id, why: rule.why, text: lines[i].trim().slice(0, 160) });
      }
    }
  }
}

console.log(
  `扫描源：${source} · 文件 ${files.length} 个（跳过二进制 ${files.length - scanned} 个）· 规则 ${RULES.length} 条`,
);
if (hits.length === 0) {
  console.log("命中 0 处 —— 通过");
  process.exit(0);
}
console.log(`命中 ${hits.length} 处 —— 不通过\n`);
for (const h of hits) {
  console.log(`${h.rel}:${h.line}  [${h.id}/${h.why}]`);
  console.log(`    ${h.text}`);
}
process.exit(1);
