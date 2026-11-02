// 集成验收：poller 的 afterEach 真的能拉起一次提取并落库（stub provider，不烧 token）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqdsh-aftereach-'));
process.env.DATA_DIR = tmp;
process.env.LLM_PROVIDER = 'stub';
process.env.LIVE_POLL_ENABLED = 'on';
process.env.AUTH_TOKEN = 'tok-aftereach';

const { buildContext } = await import('../../server/deps.js');
const { startPoller } = await import('../../live/poller.js');

const env = { ...process.env };
const { store, deps } = await buildContext(env);

let round = 0;
// 假 NapCat：第一轮给 3 条全新通知（能提出待办），之后不再给新消息
const request = async (action) => {
  if (action === 'get_group_list') return { data: [{ group_id: 900001, group_name: '验收群' }] };
  if (action === 'get_group_msg_history') {
    if (round++ > 0) return { data: { messages: [] } };
    return {
      data: {
        messages: [
          { message_id: 1001, time: Math.floor(Date.now() / 1000), sender: { card: '张老师' }, message: [{ type: 'text', data: { text: '【通知】请各班于11月10日24点前提交实践报告到学习通，逾期不候。' } }] },
          { message_id: 1002, time: Math.floor(Date.now() / 1000), sender: { card: '李同学' }, message: [{ type: 'text', data: { text: '今天食堂人多吗' } }] },
          { message_id: 1003, time: Math.floor(Date.now() / 1000), sender: { card: '王同学' }, message: [{ type: 'text', data: { text: '明天一起打球' } }] },
        ],
      },
    };
  }
  return { data: null };
};

let extracted = null;
const poller = startPoller({
  env,
  store,
  request,
  log: () => {},
  afterEach: async (summary, { signal } = {}) => {
    if (!(summary?.inserted > 0)) return;
    extracted = await deps.extract.run({ env, store, signal });
  },
});

await poller.pollOnce();
// afterEach 是 fire-and-forget，等它结算
for (let i = 0; i < 60 && extracted === null; i += 1) await new Promise((r) => setTimeout(r, 100));
poller.stop();
poller.closeClient?.();

const todos = await store.listTodos({ status: 'pending', limit: 10 });
const items = Array.isArray(todos) ? todos : todos?.items ?? [];
const hit = items.find((t) => /实践报告/.test(t.title));

const lines = [];
const check = (ok, label, detail) => {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`);
  if (!ok) process.exitCode = 1;
};
check(extracted !== null, 'afterEach 触发了提取', extracted ? `runId=${extracted.runId}` : '未触发');
check(items.length >= 1, '提取结果落进了 store', `todos=${items.length}`);
check(Boolean(hit), '抓到了实践报告这条待办', hit ? `${hit.deadline} ${hit.title}` : '未找到');
check(hit?.deadline === '2026-11-10', '截止日解析正确', hit?.deadline);
check((extracted?.droppedCount ?? -1) === 0, 'stub 下 droppedCount=0', extracted?.droppedCount);
check(fs.existsSync(path.join(tmp, 'live-poll.json')), '游标文件已落盘');

console.log(lines.join('\n'));
console.log(`RESULT ${process.exitCode ? 'FAIL' : 'PASS'}`);
fs.rmSync(tmp, { recursive: true, force: true });
