// push.js 纯离线自测：假 store + 假 webpush，不联网、不写盘、不碰真实数据。
import { createPush } from '../../src/server/push.js';

let failed = 0;
function check(name, cond, expected, actual) {
  if (cond) console.log(`PASS ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}\n  期望：${expected}\n  实际：${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  }
}
const quietLog = { warn() {}, error() {}, log() {} };

function makePush({ env = {}, subs = [], failWith = {} } = {}) {
  const items = subs.map((s) => ({ ...s, keys: { ...s.keys } }));
  const calls = [];
  const store = {
    async listPushSubscriptions() {
      return { items: items.slice(), total: items.length };
    },
    async removePushSubscription(id) {
      const i = items.findIndex((s) => s.id === id || s.endpoint === id);
      if (i >= 0) items.splice(i, 1);
      return { removed: i >= 0, total: items.length };
    },
  };
  const webpush = {
    setVapidDetails(subject, pub, priv) {
      calls.push(['vapid', subject, pub.slice(0, 4), priv.slice(0, 4)]);
    },
    async sendNotification(target) {
      const status = failWith[target.endpoint];
      if (status) {
        const err = new Error(`push failed ${status}`);
        err.statusCode = status;
        throw err;
      }
      calls.push(['send', target.endpoint]);
    },
  };
  const push = createPush({ env, store, log: quietLog, webpush });
  return { push, calls, items };
}

const sub = (n) => ({ id: `id${n}`, endpoint: `https://push.example/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

// ---- 文案与挑选 ----
console.log('--- remind 文案 ---');
{
  const { push } = makePush();
  const now = Date.parse('2026-11-01T10:00:00+08:00');
  const todos = [
    { title: '交实习材料', deadline: '2026-10-29', status: 'pending' },
    { title: '体测告知书', deadline: '2026-11-01', status: 'pending' },
    { title: '班会签到表', deadline: '2026-11-02', status: 'pending' },
  ];
  const r = await push.remind({ todos, now });
  check('三档齐全时标题按逾期优先', r.title === '有 1 件事已逾期', '有 1 件事已逾期', r.title);
  check('count = 三档总数', r.count === 3, 3, r.count);
  check('正文含逾期天数', /已逾期 3 天/.test(r.body), '含「已逾期 3 天」', r.body);
  check('正文含今天/明天的截止日期', /截止 2026-11-01/.test(r.body) && /截止 2026-11-02/.test(r.body), '含两条截止', r.body);
}
{
  const { push } = makePush();
  const now = Date.parse('2026-11-01T10:00:00+08:00');
  const r = await push.remind({ todos: [{ title: '交表', deadline: '2026-11-01', status: 'pending' }], now });
  check('只有今天到期 → 今天 N 件', r.title === '今天有 1 件事要交', '今天有 1 件事要交', r.title);
}
{
  const { push } = makePush();
  const now = Date.parse('2026-11-01T10:00:00+08:00');
  const r = await push.remind({ todos: [{ title: '交表', deadline: '2026-11-02', status: 'pending' }], now });
  check('只有明天到期 → 明天 N 件', r.title === '明天到期 1 件', '明天到期 1 件', r.title);
}

// ---- 筛选口径 ----
console.log('--- remind 筛选 ---');
{
  const { push } = makePush();
  const now = Date.parse('2026-11-01T10:00:00+08:00');
  const todos = [
    { title: '已推后', deadline: '2026-11-01', status: 'pending', snoozedUntil: '2026-11-05T00:00:00+08:00' },
    { title: '推后已过期', deadline: '2026-11-01', status: 'pending', snoozedUntil: '2026-10-01T00:00:00+08:00' },
    { title: '已完成的', deadline: '2026-11-01', status: 'done' },
    { title: '已忽略的', deadline: '2026-11-01', status: 'dismissed' },
    { title: '十五天后', deadline: '2026-11-16', status: 'pending' },
  ];
  const r = await push.remind({ todos, now });
  check('snoozed 未到期被排除', !/已推后 ·/.test(r.body), '不含「已推后」', r.body);
  check('推后已过期仍要提醒', /推后已过期/.test(r.body), '含「推后已过期」', r.body);
  check('done/dismissed 与远期都不进提醒', r.count === 1, 1, r.count);
}
{
  const { push } = makePush();
  const r = await push.remind({ todos: [{ title: '远期', deadline: '2027-01-01', status: 'pending' }], now: Date.parse('2026-11-01T10:00:00+08:00') });
  check('三档全空 → null', r === null, null, r);
}

// ---- 截断与长度 ----
console.log('--- remind 截断 ---');
{
  const { push } = makePush();
  const now = Date.parse('2026-11-01T10:00:00+08:00');
  const todos = Array.from({ length: 7 }, (_, i) => ({ title: `很长的待办标题第${i + 1}条`, deadline: '2026-11-01', status: 'pending' }));
  const r = await push.remind({ todos, now });
  const lines = r.body.split('\n');
  check('正文最多 3 条 + 1 行省略', lines.length === 4, 4, lines.length);
  check('省略行写明剩余条数', /…还有 4 件/.test(lines[3]), '…还有 4 件', lines[3]);
  check('正文不超过 120 字', r.body.length <= 120, '<= 120', r.body.length);
}

// ---- 发送：410 删除且不中断 ----
console.log('--- send ---');
{
  const { push, items } = makePush({ env: { VAPID_PUBLIC_KEY: 'pubKEY', VAPID_PRIVATE_KEY: 'privKEY' }, subs: [sub(1), sub(2), sub(3)], failWith: { 'https://push.example/2': 410 } });
  const r = await push.send({ title: 'T', body: 'B' });
  check('410 计入 removed', r.removed === 1, 1, r.removed);
  check('其余订阅照常发出', r.sent === 2, 2, r.sent);
  check('失败数不把 410 算进去', r.failed === 0, 0, r.failed);
  check('total 是清理后的剩余数', r.total === 2, 2, r.total);
  check('410 的订阅已从 store 删除', !items.some((s) => s.id === 'id2'), 'id2 已删', items.map((s) => s.id).join(','));
}
{
  const { push, items } = makePush({ env: { VAPID_PUBLIC_KEY: 'pubKEY', VAPID_PRIVATE_KEY: 'privKEY' }, subs: [sub(1), sub(2)], failWith: { 'https://push.example/1': 500 } });
  const r = await push.send({ title: 'T', body: 'B' });
  check('非 404/410 计入 failed', r.failed === 1, 1, r.failed);
  check('非 404/410 保留订阅', items.length === 2, 2, items.length);
  check('同批其它订阅仍成功', r.sent === 1, 1, r.sent);
}

// ---- 未配置 VAPID ----
console.log('--- enabled=false ---');
{
  const { push, calls } = makePush({ env: {}, subs: [sub(1)] });
  check('enabled=false', push.enabled === false, false, push.enabled);
  check('publicKey 为空串', push.publicKey() === '', '""', push.publicKey());
  const r = await push.send({ title: 'T', body: 'B' });
  check('send 返回 disabled 且全 0', r.disabled === true && r.sent === 0 && r.failed === 0 && r.removed === 0 && r.total === 0, '全 0 + disabled', r);
  check('未配置时不触发任何网络调用', calls.length === 0, 0, calls.length);
  check('remind 仍能算文案（只是不发）', (await push.remind({ todos: [{ title: 'X', deadline: new Date().toISOString().slice(0, 10), status: 'pending' }] })) !== null, '非 null', null);
}
{
  const { push } = makePush({ env: { VAPID_PUBLIC_KEY: 'only-pub' } });
  check('只配公钥也算未启用', push.enabled === false, false, push.enabled);
  const r = await push.send({ title: 'T', body: 'B' });
  check('半配置不抛错', r.disabled === true, 'disabled', r);
}

console.log(failed === 0 ? '\nALL PASS' : `\nFAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
