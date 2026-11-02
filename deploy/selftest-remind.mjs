/**
 * 自测：deploy/remind.mjs 的分档与文案（纯函数，不连网、不发消息）。
 * 跑法：node deploy/selftest-remind.mjs
 */
import { buildReminder, groupDue } from './remind.mjs';

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` -> ${detail}`}`);
  if (!ok) failed = true;
}

const TODAY = '2026-11-01';
// daysUntil 用真实「今天」算，这里用 daysLeft 直接给定档位，避免依赖运行日期
const todo = (id, title, daysLeft, extra = {}) => ({
  id,
  title,
  status: 'pending',
  daysLeft,
  deadline: TODAY,
  source: { groupName: '示例放行群' },
  ...extra,
});

// ① 三档分组正确
{
  const todos = {
    items: [
      todo('a', '交实验报告', -2),
      todo('b', '班会', 0),
      todo('c', '体测', 1),
      todo('d', '购物', 3),
      todo('e', '已完成的事', -1, { status: 'done' }),
      todo('f', '没截止日期', null, { deadline: '' }),
    ],
  };
  const g = groupDue(todos);
  check('① 逾期档只有 1 条且是已逾期 -2 天', g.overdue.length === 1 && g.overdue[0].days === -2, JSON.stringify(g.overdue.map((x) => x.todo.id)));
  check('① 今天档 1 条', g.today.length === 1, g.today.map((x) => x.todo.id).join(','));
  check('① 明天档 1 条', g.tomorrow.length === 1, g.tomorrow.map((x) => x.todo.id).join(','));
  check('① done 与无截止日期不进任何档', ![...g.overdue, ...g.today, ...g.tomorrow].some((x) => ['d', 'e', 'f'].includes(x.todo.id)), 'ok');

  const text = buildReminder(todos, Date.parse('2026-11-01T09:00:00+08:00'));
  check('① 首行带日期', text.split('\n')[0] === '待办提醒 · 11/1', text.split('\n')[0]);
  check('① 第二行给三档计数', text.split('\n')[1] === '逾期 1 · 今天 1 · 明天 1', text.split('\n')[1]);
  check('① 逾期条目带群名与逾期天数', text.includes('1. 交实验报告 · 已逾期 2 天 · 示例放行群'), 'ok');
  check('① 今天/明天条目', text.includes('1. 班会 · 今天 · 示例放行群') && text.includes('1. 体测 · 明天 · 示例放行群'), 'ok');
  check('① 3 天后到期的不进提醒', !text.includes('购物'), 'ok');
}

// ② 三档全空 → null（main 打印 nothing-due 不发送）
{
  check('② 全空返回 null', buildReminder({ items: [todo('x', '三天后的事', 4)] }) === null, 'null');
  check('② 空列表返回 null', buildReminder({ items: [] }) === null, 'null');
}

// ③ 每档最多 5 条，超出只给一句汇总
{
  const items = Array.from({ length: 8 }, (_, i) => todo(`o${i}`, `逾期事项${i}`, -1 * (i + 1)));
  const text = buildReminder({ items }, Date.parse('2026-11-01T09:00:00+08:00'));
  const numbered = text.split('\n').filter((line) => /^\d+\. /.test(line));
  check('③ 只列 5 条', numbered.length === 5, `列了 ${numbered.length} 条`);
  check('③ 剩余给一句汇总', text.includes('… 另有 3 件同类，网页上看全部'), 'ok');
}

// ④ 没有 daysLeft 时回落到 deadline（服务端字段缺失的兜底）
{
  const items = [{ id: 'z', title: '老接口待办', status: 'pending', deadline: '2026-11-02' }];
  // 用今天真实日期推：取今天 +1 天，保证落在「明天」档
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const tomorrow = new Date(Date.parse(`${today}T00:00:00+08:00`) + 86400000);
  items[0].deadline = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(tomorrow);
  const g = groupDue({ items });
  check('④ daysLeft 缺失时按 deadline 算进明天档', g.tomorrow.length === 1, JSON.stringify({ today, deadline: items[0].deadline }));
}

console.log(failed ? 'RESULT FAIL' : 'RESULT PASS');
process.exitCode = failed ? 1 : 0;
