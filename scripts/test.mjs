// 全量自测：跑 fixtures/selftests/*.mjs 与 src/live/_test/test-*.mjs，汇总 PASS/FAIL。
// 每个文件单独起进程——它们各自建临时目录、各自退出，互不污染。
// 判定：文件退出码非 0、或输出里出现 FAIL、或一条 PASS 都没打出来，都算该文件不通过。
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PER_FILE_TIMEOUT_MS = 180000;

function listTests() {
  const groups = [
    { dir: "fixtures/selftests", prefix: "" },
    { dir: "src/live/_test", prefix: "test-" },
  ];
  const files = [];
  for (const { dir, prefix } of groups) {
    const abs = path.join(ROOT, dir);
    let names = [];
    try {
      names = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".mjs")) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      const full = path.join(abs, name);
      if (!statSync(full).isFile()) continue;
      files.push({ rel: path.relative(ROOT, full).replace(/\\/g, "/"), abs: full });
    }
  }
  return files;
}

function runOne({ rel, abs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [abs], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      err += `\n[timeout] ${PER_FILE_TIMEOUT_MS}ms 未结束，已终止`;
      child.kill("SIGKILL");
    }, PER_FILE_TIMEOUT_MS);

    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ rel, code: -1, out: `[spawn error] ${e.message}\n${out}`, err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ rel, code: code ?? -1, out, err });
    });
  });
}

const count = (text, re) => (text.match(re) || []).length;

const files = listTests();
if (files.length === 0) {
  console.error("没找到任何测试文件（fixtures/selftests/*.mjs、src/live/_test/test-*.mjs）");
  process.exit(1);
}

console.log(`发现 ${files.length} 个测试文件，逐个执行\n`);
const rows = [];
for (const file of files) {
  const r = await runOne(file);
  const pass = count(r.out, /^PASS\b/gm);
  const fail = count(r.out, /^FAIL\b/gm);
  // 有些断言用 ✓/✗，兜一层
  const okMark = count(r.out, /^\s*(✓|✔)/gm);
  const badMark = count(r.out, /^\s*(✗|✘|×)/gm);
  const passed = pass + okMark;
  const failed = fail + badMark;
  const ok = r.code === 0 && failed === 0 && passed > 0;
  rows.push({ rel: r.rel, code: r.code, pass: passed, fail: failed, ok, out: r.out, err: r.err });
  console.log(`${ok ? "PASS" : "FAIL"}  ${r.rel}  断言 ${passed}/${passed + failed}  退出码 ${r.code}`);
  if (!ok) {
    const bad = r.out.split(/\r?\n/).filter((l) => /^(FAIL\b|\s*(✗|✘|×))/.test(l));
    for (const line of bad.slice(0, 40)) console.log(`        ${line.trim()}`);
    if (bad.length === 0) {
      console.log(`        没有 FAIL 行，但退出码 ${r.code} 或断言数为 0`);
      const tail = (r.out + r.err).trim().split(/\r?\n/).slice(-12);
      for (const line of tail) console.log(`        ${line}`);
    }
    if (r.err.trim()) {
      const tail = r.err.trim().split(/\r?\n/).slice(-8);
      for (const line of tail) console.log(`        [stderr] ${line}`);
    }
  }
}

const bad = rows.filter((r) => !r.ok);
const totalPass = rows.reduce((n, r) => n + r.pass, 0);
const totalFail = rows.reduce((n, r) => n + r.fail, 0);

console.log("\n================ 汇总 ================");
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.rel.padEnd(46)} 断言 ${r.pass}/${r.pass + r.fail}  退出码 ${r.code}`);
}
console.log("--------------------------------------");
console.log(`文件 ${rows.length - bad.length}/${rows.length} 通过 · 断言 ${totalPass}/${totalPass + totalFail} 通过 · FAIL ${totalFail}`);
if (bad.length > 0) {
  console.log(`不通过的文件：${bad.map((r) => r.rel).join("、")}`);
  process.exit(1);
}
console.log("全部通过");
