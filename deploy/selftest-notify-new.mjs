/**
 * 自测：deploy/notify-new.mjs 的状态机（假 store + 假发送器，不连真机、不写真实库）。
 * 跑法：node deploy/selftest-notify-new.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildText, parseArgs, runNotifyNew } from './notify-new.mjs';

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const dir = mkdtempSync(path.join(tmpdir(), 'qq-notify-new-'));
const stateFile = path.join(dir, 'notify-new-state.json');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-02T20:00:00+08:00');
let clock = T0;
const iso = (ms = clock) => new Date(ms).toISOString();

let seq = 0;
function todo(title, extra = {}) {
  seq += 1;
  return {
    id: `t_${seq}`,
    title,
    status: 'pending',
    createdAt: iso(),
    deadline: null,
    deadlineText: null,
    source: { groupName: '测仪2602班群' },
    ...extra,
  };
}

const todos = [];
const store = { listTodos: () => ({ items: todos.slice(), stats: { pending: todos.length, done: 0, dismissed: 0 } }) };
const sent = [];
const sender = async (text) => {
  sent.push(text);
  return { ok: true, status: 'ok', detail: '{"message_id":1}' };
};
const quiet = () => {};

const run = (argv = [], extra = {}) =>
  runNotifyNew({ store, dataDir: dir, stateFile, argv, now: () => clock, log: quiet, send: sender, ...extra });

// ---- ① 首次推出 2 条 ----
todos.push(todo('提交体测安全风险告知书', { deadline: '2026-10-12' }), todo('收取实验报告'));
clock = T0 + 60 * 1000;
const r1 = await run(['--since', iso(T0 - MIN)]);
check('① 首次推送 1 条消息', sent.length === 1, `sent=${sent.length}`);
check('① 带出 2 个 id', r1.ids.length === 2, JSON.stringify(r1.ids));
check('① 首行是「新待办 · 11月2日 20:01」', r1.text.split('\n')[0] === '新待办 · 11月2日 20:01', r1.text.split('\n')[0]);
check('① 截止日写法', r1.text.includes('1. 提交体测安全风险告知书 ｜ 10月12日截止 · 测仪2602班群'), 'ok');
check('① 未标注截止写法', r1.text.includes('2. 收取实验报告 ｜ 未标注截止 · 测仪2602班群'), 'ok');
check('① 结尾件数', r1.text.split('\n').at(-1) === '共 2 件，打开待办台查看', r1.text.split('\n').at(-1));

// ---- ② 同一批 id 再跑不推 ----
clock += 1000;
const r2 = await run();
check('② 再跑一次不推送', sent.length === 1 && r2.action === 'nothing-new', `${r2.action} sent=${sent.length}`);

// ---- ③ 限流：本小时第 4 次被压住 ----
clock += 10 * MIN;
todos.push(todo('体测报名'));
const r3 = await run();
check('③ 第 2 次正常推送', r3.action === 'send' && sent.length === 2, `${r3.action} sent=${sent.length}`);

clock += 10 * MIN;
todos.push(todo('班会签到'));
const r4 = await run();
check('③ 第 3 次正常推送', r4.action === 'send' && sent.length === 3, `${r4.action} sent=${sent.length}`);

clock += 10 * MIN;
todos.push(todo('交实验报告'));
const r5 = await run();
check('③ 第 4 次被限流压住', r5.action === 'rate-limited' && sent.length === 3, `${r5.action} sent=${sent.length}`);
check('③ 被压住的 id 记在 pendingIds', r5.ids.length === 1, JSON.stringify(r5.ids));

// ---- ④ 窗口滑过之后，累积的一并推 ----
clock += 40 * MIN; // 距第 3 次推送已 50 分钟、距第 1 次 80 分钟 → 窗口内只剩 1 次
todos.push(todo('晚自习点名'));
const r6 = await run();
check('④ 窗口滑过后恢复推送', r6.action === 'send' && sent.length === 4, `${r6.action} sent=${sent.length}`);
check('④ 上轮积压与新一轮合并', r6.ids.length === 2, JSON.stringify(r6.ids));
check('④ 合并后没有重复 id', new Set(r6.ids).size === r6.ids.length, 'ok');

// ---- ⑤ 状态文件：原子写、可解析、字段齐全 ----
const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
check('⑤ 没有残留 .tmp', readdirSync(dir).every((f) => !f.endsWith('.tmp')), readdirSync(dir).join(','));
check('⑤ 状态文件可解析且 version=1', saved.version === 1, JSON.stringify(Object.keys(saved)));
check('⑤ sentIds 记下 6 个已推 id', saved.sentIds.length === 6, `sentIds=${saved.sentIds.length}`);
check('⑤ pendingIds 已清空', saved.pendingIds.length === 0, JSON.stringify(saved.pendingIds));
check('⑤ pushes 只留 1 小时窗口内的 2 次', saved.pushes.length === 2, `pushes=${saved.pushes.length}`);
check('⑤ lastNotifiedAt 是 ISO 时间', Number.isFinite(Date.parse(saved.lastNotifiedAt)), saved.lastNotifiedAt);

// ---- ⑥ 空数据不发 ----
const emptyDir = mkdtempSync(path.join(tmpdir(), 'qq-notify-new-empty-'));
const before = sent.length;
const r7 = await runNotifyNew({
  store: { listTodos: () => ({ items: [], stats: {} }) },
  dataDir: emptyDir,
  stateFile: path.join(emptyDir, 'state.json'),
  argv: ['--since', iso(T0)],
  now: () => clock,
  log: quiet,
  send: sender,
});
check('⑥ 空数据不发消息', sent.length === before && r7.action === 'nothing-new', `${r7.action}`);

// ---- 附加：首次运行只记基线；--dry-run 不发送；>5 条折行；解析器 ----
const baselineDir = mkdtempSync(path.join(tmpdir(), 'qq-notify-new-base-'));
const r8 = await runNotifyNew({
  store,
  dataDir: baselineDir,
  stateFile: path.join(baselineDir, 'state.json'),
  argv: [],
  now: () => clock,
  log: quiet,
  send: sender,
});
check('附加 首次运行只记基线不推送', r8.action === 'baseline' && sent.length === before, r8.action);

const dryDir = mkdtempSync(path.join(tmpdir(), 'qq-notify-new-dry-'));
const r9 = await runNotifyNew({
  store,
  dataDir: dryDir,
  stateFile: path.join(dryDir, 'state.json'),
  argv: ['--ids', todos.map((t) => t.id).join(','), '--dry-run'],
  now: () => clock,
  log: quiet,
  send: sender,
});
check('附加 --dry-run 只打印不发送', r9.action === 'dry-run' && sent.length === before, r9.action);
check('附加 dry-run 不写状态文件', readdirSync(dryDir).length === 0, readdirSync(dryDir).join(',') || '空目录');

const many = Array.from({ length: 9 }, (_, i) => todo(`批量事项${i}`));
const text7 = buildText(many, clock);
check('附加 超过 5 条写「…还有 N 件」', text7.includes('…还有 4 件'), text7.split('\n').slice(-2).join(' / '));
check('附加 只列 5 行编号', text7.split('\n').filter((l) => /^\d+\. /.test(l)).length === 5, 'ok');

const parsed = parseArgs(['--ids', 'a, b ,a', '--since=2026-11-02T10:00:00+08:00', '--dry-run']);
check('附加 --ids 去重去空', JSON.stringify(parsed.ids) === '["a","b"]', JSON.stringify(parsed.ids));
check('附加 --since= 可解析', parsed.since === Date.parse('2026-11-02T10:00:00+08:00'), String(parsed.since));
check('附加 --dry-run 识别', parsed.dryRun === true, 'true');

for (const d of [dir, emptyDir, baselineDir, dryDir]) rmSync(d, { recursive: true, force: true });
console.log(failed ? 'RESULT FAIL' : 'RESULT PASS');
process.exitCode = failed ? 1 : 0;
