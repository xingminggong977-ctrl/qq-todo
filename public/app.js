// QQ 待办台 · 纯 vanilla 前端。只用 SPEC §4 定义的接口与字段，不引任何依赖。
const TZ = 'Asia/Shanghai';

const KIND_LABEL = { file: '文件', image: '图片', reply: '回复', at_all: '@全员', mixed: '混合' };
const STATUS_LABEL = { pending: '待处理', done: '已完成', dismissed: '已排除' };
const MESSAGE_PAGE = 100; // 一屏先给 100 条，不够再「加载更多」

const state = {
  tab: 'messages',
  filters: { msgQ: '', msgGroup: '', todo: 'all' },
  messages: { items: [], groups: [], total: 0, limit: MESSAGE_PAGE, loading: false, loaded: false, error: null },
  todos: { pending: [], done: [], stats: { pending: 0, done: 0, dismissed: 0 }, loading: false, loaded: false, error: null },
  stats: { data: null, loading: false, loaded: false, error: null },
  groups: { items: null, loading: false, loaded: false, error: null, missing: false },
  decisions: { items: null, loading: false, loaded: false, error: null, missing: false },
  live: null,
  push: {
    loaded: false, loading: false, missing: false, error: null,
    enabled: null, publicKey: null, permission: 'default', subscription: null,
    iosBlocked: false, busy: false,
  },
  snooze: { openId: null },
  snoozed: {},
  busy: { ingest: false, extract: false },
  drawer: { open: false, id: null, todo: null, message: null, loading: false, error: null },
  lightbox: { open: false, name: '' },
  net: { offline: typeof navigator !== 'undefined' && navigator.onLine === false },
  retry: { active: 0, lastAt: 0, autoStep: {}, autoTimers: {} },
  poll: { timer: null, running: false, fails: 0, dirty: false, armed: false, lastSig: '', ticks: 0 },
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const fileInput = $('#file-input');
const drawerEl = $('#drawer');
const overlayEl = $('#drawer-overlay');
const drawerBody = $('#drawer-body');

// ---------- 工具 ----------
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? new Intl.NumberFormat('en-US').format(v) : '—');

function dayDiff(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

function bjDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function bjClock(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')}`;
}

const todayISO = () => bjDateStr(new Date());

// 与共享模块 formatRelative 的三种形态保持一致：今天 / 昨天 / MM-DD
function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = bjDateStr(d);
  const diff = dayDiff(todayISO(), day);
  if (diff === 0) return `今天 ${bjClock(d)}`;
  if (diff === 1) return `昨天 ${bjClock(d)}`;
  return `${day.slice(5)} ${bjClock(d)}`;
}

function daysLeft(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  return dayDiff(String(dateStr).slice(0, 10), todayISO());
}

function urgencyOf(deadline) {
  const left = daysLeft(deadline);
  if (left === null) return 'later';
  if (left < 0) return 'overdue';
  if (left <= 3) return 'soon';
  if (left <= 14) return 'upcoming';
  return 'later';
}

function deadlineLabel(todo) {
  if (todo.deadline && /^\d{4}-\d{2}-\d{2}/.test(todo.deadline)) {
    const [y, m, d] = todo.deadline.slice(0, 10).split('-');
    const sameYear = String(y) === todayISO().slice(0, 4);
    return `${sameYear ? '' : `${Number(y)}年`}${Number(m)}月${Number(d)}日 截止`;
  }
  return '未标注截止';
}

// ---------- 时间线分组（前端算，后端不参与） ----------
const TL_SECTIONS = [
  { key: 'overdue', label: '已逾期' },
  { key: 'today', label: '今天' },
  { key: 'd3', label: '3 天内' },
  { key: 'week', label: '本周内' },
  { key: 'month', label: '本月内' },
  { key: 'later', label: '以后' },
  { key: 'none', label: '无截止日' },
  { key: 'snoozed', label: '已推后' },
];

function isoAddDays(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 周一算一周的开始，周日收尾
function weekEndISO(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = 周日
  return isoAddDays(iso, weekday === 0 ? 0 : 7 - weekday);
}

function monthEndISO(iso) {
  const [y, m] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const SNOOZE_PRESETS = [
  { key: 'tomorrow', label: '明天' },
  { key: '3d', label: '3 天后' },
  { key: '1w', label: '下周' },
  { key: 'tonight', label: '今晚' },
];

// 后端若返回 snoozedUntil（或本地刚推后过），用它作为推后标记
function snoozeISO(todo) {
  if (!todo || !todo.id) return '';
  const raw = todo.snoozedUntil || todo.snoozeUntil || todo.snoozedAt || todo.snooze;
  const s = typeof raw === 'string' ? raw.slice(0, 10) : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return state.snoozed[todo.id] || '';
}

function shortDate(iso) {
  const [, m, d] = String(iso).slice(0, 10).split('-');
  return `${Number(m)}月${Number(d)}日`;
}

// 只取 YYYY-MM-DD 部分，给 <input type="date"> 用
function isoDay(value) {
  const s = typeof value === 'string' ? value.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function timelineKey(todo) {
  if (snoozeISO(todo)) return 'snoozed';
  const left = daysLeft(todo.deadline);
  if (left === null) return 'none';
  if (left < 0) return 'overdue';
  if (left === 0) return 'today';
  if (left <= 3) return 'd3';
  const day = String(todo.deadline).slice(0, 10);
  const today = todayISO();
  if (day <= weekEndISO(today)) return 'week';
  if (day <= monthEndISO(today)) return 'month';
  return 'later';
}

function todoSections(list) {
  const buckets = new Map(TL_SECTIONS.map((s) => [s.key, []]));
  for (const t of sortPending(list)) {
    const key = timelineKey(t);
    if (buckets.has(key)) buckets.get(key).push(t);
  }
  return TL_SECTIONS
    .filter((s) => buckets.get(s.key).length)
    .map((s) => ({ ...s, items: buckets.get(s.key) }));
}

// 紧急：deadline ≤1 天、标题/理由带急词、原文 @全体
const URGENT_RE = /紧急|立即|马上|今天|今晚|今晚前/;
const AT_ALL_RE = /@全体|@所有人/;

function messageTextOf(todo) {
  if (!todo || !todo.messageId) return '';
  const hit = state.messages.items.find((m) => m && m.id === todo.messageId);
  return hit && hit.text ? String(hit.text) : '';
}

function isUrgent(todo) {
  const left = daysLeft(todo.deadline);
  if (left !== null && left <= 1) return true;
  const hay = [
    todo.title, todo.deadlineText, todo.reason,
    ...(Array.isArray(todo.constraints) ? todo.constraints : []),
    messageTextOf(todo),
  ].filter(Boolean).join(' ');
  return URGENT_RE.test(hay) || AT_ALL_RE.test(hay);
}

// ---------- 接口 ----------
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = status; // code === 0：网络层失败或超时（可重试）
  }
}

// 演示站：/demo/ 下整套 API 换到 /demo/api，且只读、不注册 SW
const IS_DEMO = /^\/demo(\/|$)/.test(location.pathname);
const API_PREFIX = IS_DEMO ? '/demo/api' : '/api';
// 演示站里不该落地的写操作：点了只弹提示，不改数据
const DEMO_WRITE_ACTIONS = new Set([
  'import', 'extract', 'done', 'restore', 'dismiss', 'snooze',
  'group-mode', 'push-enable', 'push-disable', 'push-test',
]);
const DEMO_READONLY_TIP = '演示模式只读，想改数据请在自己机器上跑一份';

// 静态页可能带 ?t=<token> 打开，接口请求沿用同一个 token
function apiUrl(path) {
  const url = new URL(path, location.origin);
  if (IS_DEMO) {
    // 演示只读、无口令：换前缀，不带 t，也不依赖 Cookie
    url.pathname = API_PREFIX + url.pathname.replace(/^\/api/, '');
    return url.pathname + url.search;
  }
  const token = new URLSearchParams(location.search).get('t');
  if (!token) return path;
  url.searchParams.set('t', token);
  return url.pathname + url.search;
}

const API_ATTEMPTS = 3; // 弱网下 GET 最多打 3 次
const API_BACKOFF = [300, 900]; // 第 1、2 次失败后分别等 300ms / 900ms
const apiInflight = new Map(); // 同一 key 的并发去重，重试不许把请求数翻倍

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 只有「网络层失败/超时」（status 0）与 5xx 值得重试；4xx 立刻交给调用方（401 要走登录引导）
function isRetryable(err) {
  return !!err && typeof err.status === 'number' && (err.status === 0 || err.status >= 500);
}

function noteRetry(delta) {
  state.retry.active = Math.max(0, state.retry.active + delta);
  if (delta > 0) state.retry.lastAt = Date.now();
  renderLive(); // 重试期间顶栏切「重连中」，成功/放弃后自动复位
}

async function apiOnce(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }

  // 隧道偶尔会「连上但不回包」，不给超时就会无限转圈，用户只能怀疑是不是卡死
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    init.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  let res;
  try {
    res = await fetch(apiUrl(path), init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw new ApiError(0, '网络超时了，多半是隧道抖了一下，点重试');
    throw new ApiError(0, '网络连接失败，请确认服务正在运行');
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (err) { data = null; }
  }

  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, msg);
  }
  if (data === null) throw new ApiError(res.status, '服务返回的不是合法 JSON');
  return data;
}

async function api(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  // 只对只读请求自动重试：PATCH/POST 重试会把写入做两遍
  const canRetry = method === 'GET' || method === 'HEAD';
  const key = `${method} ${path}`;

  if (canRetry && apiInflight.has(key)) return apiInflight.get(key);

  const run = (async () => {
    const attempts = canRetry ? API_ATTEMPTS : 1;
    let lastErr = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await apiOnce(path, opts);
      } catch (err) {
        lastErr = err;
        const hasNext = i < attempts - 1;
        if (!(canRetry && hasNext && isRetryable(err) && !state.net.offline)) throw err;
        noteRetry(1);
        try {
          await sleep(API_BACKOFF[Math.min(i, API_BACKOFF.length - 1)]);
        } finally {
          noteRetry(-1);
        }
      }
    }
    throw lastErr;
  })();

  if (canRetry) {
    apiInflight.set(key, run);
    const done = () => { if (apiInflight.get(key) === run) apiInflight.delete(key); };
    run.then(done, done);
  }
  return run;
}

function apiError(err) {
  if (err instanceof ApiError) return err.message;
  return (err && err.message) || '未知错误';
}

// 网络层抖动时不该让用户看见「请求失败」，告诉他后台正在补
const NET_ERROR_TEXT = '网络不太稳，正在自动重试…';

function loadErrorText(err) {
  return isRetryable(err) ? NET_ERROR_TEXT : apiError(err);
}

// 首屏失败后自己在后台补拉（不要求用户手动刷新）：5s → 10s → 20s → 30s 封顶
function scheduleAutoRetry(target) {
  if (state.net.offline) return;
  const step = state.retry.autoStep[target] || 0;
  const delay = Math.min(5000 * Math.pow(2, step), 30000);
  state.retry.autoStep[target] = step + 1;
  clearTimeout(state.retry.autoTimers[target]);
  state.retry.autoTimers[target] = setTimeout(() => {
    state.retry.autoTimers[target] = null;
    if (state.net.offline) return;
    retry(target);
  }, delay);
}

function cancelAutoRetry(target) {
  clearTimeout(state.retry.autoTimers[target]);
  state.retry.autoTimers[target] = null;
  state.retry.autoStep[target] = 0;
}

// ---------- 通用块 ----------
function loadingBlock(text) {
  return `<div class="state"><div class="spinner" aria-hidden="true"></div><p>${esc(text)}</p></div>`;
}

function errorBlock(message, target) {
  return `<div class="state state-error" role="alert">
    <p class="state-title">加载失败</p>
    <p class="state-msg">${esc(message)}</p>
    <button class="btn btn-sm" data-action="retry" data-target="${esc(target)}">重试</button>
  </div>`;
}

// 空库判定只认「统计已经成功拉到且 messages 为 0」，拿不到统计就别乱引导
function isEmptyLibrary() {
  const d = state.stats.data;
  return !!(d && d.counts && d.counts.messages === 0);
}

// 第一次打开（空库）的三条上手路径：导入 / 机器人转发 / 先看演示
function guideCard() {
  const importItem = IS_DEMO
    ? `<div class="guide-item">
        <span class="guide-num">1</span>
        <div class="guide-main">
          <h3>导入 QQ 导出的聊天记录</h3>
          <p>QQ 消息管理器 → 右键目标群 → 导出消息记录 → 选 <b>txt</b> → 回到页面点「导入聊天记录」。</p>
        </div>
      </div>`
    : `<button class="guide-item" type="button" data-action="import">
        <span class="guide-num">1</span>
        <div class="guide-main">
          <h3>导入 QQ 导出的聊天记录</h3>
          <p>QQ 消息管理器 → 右键目标群 → 导出消息记录 → 选 <b>txt</b> → 回到页面点「导入聊天记录」。</p>
        </div>
        <span class="guide-go">去导入</span>
      </button>`;
  return `<section class="guide" aria-label="上手引导">
    <h2 class="guide-title">还没有数据，先挑一条路把聊天记录喂进来</h2>
    <p class="guide-sub">全程在本机跑：消息不出你的机器，判定用自己的模型或 stub。</p>
    <ol class="guide-list">
      <li>${importItem}</li>
      <li><button class="guide-item" type="button" data-action="guide-bot">
        <span class="guide-num">2</span>
        <div class="guide-main">
          <h3>让机器人把通知转发给你</h3>
          <p>把群通知转发给机器人小号，消息会自动进库（需要先配置 NapCat）。</p>
        </div>
        <span class="guide-go">怎么接</span>
      </button></li>
      <li><a class="guide-item" href="/demo/">
        <span class="guide-num">3</span>
        <div class="guide-main">
          <h3>先看在线演示</h3>
          <p>不想现在动手？打开只读演示站，看看整理完的待办台长什么样。</p>
        </div>
        <span class="guide-go">看演示</span>
      </a></li>
    </ol>
  </section>`;
}

function emptyBlock(title, hint, actionLabel, action) {
  const btn = actionLabel
    ? `<button class="btn" data-action="${esc(action)}">${esc(actionLabel)}</button>`
    : '';
  return `<div class="state">
    <p class="state-title">${esc(title)}</p>
    <p>${esc(hint)}</p>
    ${btn}
  </div>`;
}

// ---------- 消息流 ----------
// ---------- 图片 ----------
// 服务端只给文件名；走同一个 apiUrl，带 ?t= 或同源 Cookie 才拿得到 200
function imageUrl(name) {
  return apiUrl(`/api/images/${encodeURIComponent(String(name))}`);
}

function imageThumb(m) {
  const name = m && m.imageFile;
  if (!name) return '';
  const url = imageUrl(name);
  return `<figure class="msg-img-wrap" data-img="${esc(name)}">
    <img class="msg-img" src="${esc(url)}" alt="群消息图片" loading="lazy" decoding="async"
      data-action="zoom-image" data-img="${esc(name)}" role="button" tabindex="0">
    <figcaption class="msg-img-fail">图片加载失败</figcaption>
  </figure>`;
}

function messageRow(m) {
  const kind = m.kind || 'text';
  const badge = KIND_LABEL[kind] ? `<span class="badge badge-${esc(kind)}">${esc(KIND_LABEL[kind])}</span>` : '';
  const attach = m.attachment && m.attachment.name
    ? `<div class="msg-att"><span class="badge badge-file">附件 ${esc(m.attachment.name)}</span></div>`
    : '';
  return `<article class="msg${m.noise ? ' noise' : ''}">
    <div class="msg-head">
      <span class="msg-group" title="${esc(m.groupName)}">${esc(m.groupName)}</span>
      <span class="msg-sender">${esc(m.sender)}</span>
      <span class="msg-time">${esc(formatRelative(m.ts))}</span>
      ${badge}
    </div>
    <p class="msg-text">${esc(String(m.text || '').replace(/\s*\n+\s*/g, ' ').trim())}</p>
    ${attach}
    ${imageThumb(m)}
  </article>`;
}

const normQ = (v) => String(v == null ? '' : v).toLowerCase().trim();

// 检索只在已加载的这批消息里做（后端接口不动）
function messageMatches(m, q, group) {
  if (group && (m.groupName || '') !== group) return false;
  if (!q) return true;
  return normQ(`${m.groupName || ''}\u0000${m.sender || ''}\u0000${m.text || ''}`).includes(q);
}

function filteredMessages() {
  const q = normQ(state.filters.msgQ);
  const group = state.filters.msgGroup;
  return state.messages.items.filter((m) => messageMatches(m, q, group));
}

// 群选项从当前已加载的消息里聚合，名字按条数倒序
function groupOptions() {
  const map = new Map();
  for (const m of state.messages.items) {
    const name = m.groupName || '(未知群)';
    map.set(name, (map.get(name) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
}

function filterBar() {
  const q = state.filters.msgQ;
  const group = state.filters.msgGroup;
  const options = groupOptions().map(([name, n]) => (
    `<option value="${esc(name)}"${name === group ? ' selected' : ''}>${esc(name)}（${num(n)}）</option>`
  )).join('');
  return `<div class="filter-bar">
    <label class="search${q ? ' has-value' : ''}">
      <input id="msg-search" type="search" placeholder="搜索群名 / 发送者 / 正文" value="${esc(q)}"
        autocomplete="off" enterkeyhint="search" aria-label="搜索消息">
      <button class="search-clear" type="button" data-action="clear-search" aria-label="清空搜索">✕</button>
    </label>
    <label class="group-select">
      <select id="msg-group" aria-label="按群筛选">
        <option value="">全部群（${num(groupOptions().length)}）</option>
        ${options}
      </select>
    </label>
  </div>`;
}

function msgResultsHtml() {
  const m = state.messages;
  const q = normQ(state.filters.msgQ);
  const group = state.filters.msgGroup;

  if (q || group) {
    const hit = filteredMessages();
    const meta = `<div class="meta">匹配 ${num(hit.length)} 条 · 搜索范围 ${num(m.items.length)} 条</div>`;
    if (!hit.length) {
      return meta + `<div class="state">
        <p class="state-title">没有匹配的消息</p>
        <p>换个关键词，或把「群」切回全部群</p>
        <button class="btn" data-action="clear-filters">清空筛选</button>
      </div>`;
    }
    return meta + `<div class="msg-list">${hit.map(messageRow).join('')}</div>`;
  }

  const meta = `<div class="meta">共 ${num(m.total)} 条（不含闲聊）· ${num(m.groups.length)} 个群${
    m.items.length < m.total ? ` · 已显示 ${num(m.items.length)} 条` : ''}</div>`;
  const more = m.items.length < m.total
    ? `<button class="load-more" data-action="more-messages"${m.loading ? ' disabled' : ''}>${
        m.loading ? '加载中…' : `加载更多（还有 ${num(m.total - m.items.length)} 条）`}</button>`
    : '';
  return meta + `<div class="msg-list">${m.items.map(messageRow).join('')}</div>` + more;
}

// 只重绘结果区：输入框不被重建，光标和输入法状态都保得住
function refreshMessageResults() {
  const box = $('#msg-results');
  if (!box) return;
  box.innerHTML = msgResultsHtml();
}

function messagesView() {
  const m = state.messages;
  // 演示站不提供导入/判断入口（只读），真实站照旧
  const actions = IS_DEMO ? '' : `<div class="actions">
    <button class="btn" data-action="import"${state.busy.ingest ? ' disabled' : ''}>${state.busy.ingest ? '导入中…' : '导入聊天记录'}</button>
    <button class="btn btn-primary" data-action="extract"${state.busy.extract ? ' disabled' : ''}>${state.busy.extract ? '理解中…' : '开始判断'}</button>
  </div>`;

  if (!m.loaded && !m.error) return actions + loadingBlock('正在读取消息…');
  if (m.error) return actions + errorBlock(m.error, 'messages');
  if (!m.items.length) {
    if (isEmptyLibrary()) return actions + guideCard();
    return actions + emptyBlock('还没有聊天记录', '先导入 QQ 导出的聊天记录（.txt），再点「开始判断」', '导入聊天记录', 'import');
  }
  return actions + filterBar() + `<div id="msg-results">${msgResultsHtml()}</div>`;
}

// ---------- 待办台 ----------
function todoCard(todo, isDone) {
  const urgency = urgencyOf(todo.deadline);
  const chips = (Array.isArray(todo.constraints) ? todo.constraints : [])
    .slice(0, 3).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  const group = todo.source && todo.source.groupName ? todo.source.groupName : '';
  const deadlineCls = urgency === 'overdue' ? ' overdue' : urgency === 'soon' ? ' soon' : '';
  const overdueTag = !isDone && urgency === 'overdue'
    ? '<span class="tag-overdue" title="已过截止时间">已逾期</span>'
    : '';
  const snoozed = isDone ? '' : snoozeISO(todo);
  const snoozedTag = snoozed
    ? `<span class="tag-snoozed" title="已推后到 ${esc(shortDate(snoozed))}">已推后·${esc(shortDate(snoozed))}</span>`
    : '';
  const urgentDot = !isDone && isUrgent(todo)
    ? '<span class="urgent-dot" title="紧急" aria-label="紧急"></span>'
    : '';
  const menuOpen = !isDone && state.snooze.openId === todo.id;
  const id = esc(todo.id);

  const check = isDone
    ? `<button class="check is-done" data-action="restore" data-id="${id}" aria-label="恢复为待办" title="点一下恢复待办"><i>✓</i></button>`
    : `<button class="check" data-action="done" data-id="${id}" aria-label="标记为已完成"><i></i></button>`;

  return `<article class="todo${isDone ? ' is-done' : ''}" data-id="${id}" data-urgency="${urgency}">
    <div class="todo-main">
      <div class="todo-row">
        ${check}
        <span class="badge-todo">待办</span>
        ${urgentDot}
        <h3 class="todo-title">${esc(todo.title)}</h3>
        <span class="todo-when">${overdueTag}${snoozedTag}<span class="deadline${deadlineCls}" title="${esc(todo.deadlineText || todo.deadline || '未标注截止')}">${esc(deadlineLabel(todo))}</span></span>
      </div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      <div class="todo-foot">
        <button class="link" data-action="open" data-id="${id}">查看完整原文</button>
        <div class="foot-actions">
          ${group ? `<span class="src" title="${esc(group)}">来源：${esc(group)}</span>` : ''}
          ${isDone ? '' : `<div class="snooze-wrap">
            <button class="snooze-btn${menuOpen ? ' is-open' : ''}" data-action="snooze-menu" data-id="${id}"
              aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}">推后</button>
          </div>`}
          ${isDone ? '' : `<button class="dismiss" data-action="dismiss" data-id="${id}">不是待办</button>`}
        </div>
      </div>
      ${menuOpen ? `<div class="snooze-menu" role="menu" aria-label="推后到">
        ${SNOOZE_PRESETS.map((p) => `<button role="menuitem" data-action="snooze" data-preset="${p.key}" data-id="${id}">${p.label}</button>`).join('')}
      </div>` : ''}
    </div>
  </article>`;
}

function sortPending(list) {
  return [...list].sort((a, b) => {
    const da = a.deadline || '';
    const db = b.deadline || '';
    if (da && db) return da === db ? 0 : (da < db ? -1 : 1);
    if (da) return -1;
    if (db) return 1;
    return 0;
  });
}

// 紧凑完成度卡片：数据取 /api/stats 的 counts，拿不到就整张隐藏
function progressCard() {
  const counts = state.stats.data && state.stats.data.counts;
  if (!counts || typeof counts.todos !== 'number' || !counts.todos) return '';
  const done = typeof counts.done === 'number' ? counts.done : 0;
  const total = counts.todos;
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  return `<section class="progress-card" aria-label="完成度（累计）">
    <div class="pc-head"><span class="pc-title">已完成 <b>${num(done)}</b> / 共 ${num(total)}</span><span class="pc-pct">${pct}%</span></div>
    <div class="pc-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
  </section>`;
}

function sectionsHtml(sections) {
  return sections.map((s) => `<section class="tl" data-section="${s.key}">
    <div class="tl-head"><span class="tl-name">${esc(s.label)}</span><span class="tl-count">${num(s.items.length)}</span></div>
    <div class="todo-list">${s.items.map((x) => todoCard(x, false)).join('')}</div>
  </section>`).join('');
}

function doneZone(done, statsDone) {
  const head = `<div class="done-head"><b>已完成</b><span class="pipe">|</span><span>勾选的事项</span></div>`;
  if (!done.length) {
    if (!statsDone) return '';
    return `<section class="done-zone">${head}<p class="meta">已完成 ${num(statsDone)} 项（明细未加载）</p></section>`;
  }
  return `<section class="done-zone">${head}${done.map((t) => todoCard(t, true)).join('')}</section>`;
}

const TODO_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天到期' },
  { key: 'overdue', label: '已逾期' },
];

function todoFilterMatch(todo) {
  const f = state.filters.todo;
  if (f === 'all') return true;
  if (snoozeISO(todo)) return false; // 推后项归「已推后」段，不参与时间筛选
  const left = daysLeft(todo.deadline);
  if (left === null) return false;
  return f === 'today' ? left === 0 : left < 0;
}

function todoFilterBar(pending) {
  const counts = { all: pending.length, today: 0, overdue: 0 };
  for (const t of pending) {
    if (snoozeISO(t)) continue;
    const left = daysLeft(t.deadline);
    if (left === null) continue;
    if (left === 0) counts.today += 1;
    else if (left < 0) counts.overdue += 1;
  }
  const active = state.filters.todo;
  const buttons = TODO_FILTERS.map(({ key, label }) => `<button type="button" data-action="todo-filter"
    data-filter="${key}" class="${active === key ? 'is-active' : ''}"
    aria-pressed="${active === key ? 'true' : 'false'}">${label}<span class="n">${num(counts[key])}</span></button>`).join('');
  return `<div class="todo-filters" role="group" aria-label="待办筛选">${buttons}</div>`;
}

function todosView() {
  const t = state.todos;
  if (!t.loaded && !t.error) return loadingBlock('正在整理待办…');
  if (t.error) return errorBlock(t.error, 'todos');

  const pending = sortPending(t.pending);
  const active = state.filters.todo;
  const meta = `<div class="meta">待办 ${num(t.stats.pending)} · 已完成 ${num(t.stats.done)} · 已排除 ${num(t.stats.dismissed)}</div>`;
  const card = progressCard();

  if (!pending.length && !t.done.length) {
    if (isEmptyLibrary()) return card + meta + guideCard();
    return card + meta + emptyBlock('暂时没有待办', '先导入聊天记录，再点「开始判断」，我会挑出真正需要你处理的', '去消息流', 'goto-messages');
  }

  const sections = todoSections(pending.filter(todoFilterMatch));
  let list;
  if (sections.length) {
    list = sectionsHtml(sections);
  } else if (active !== 'all') {
    const label = (TODO_FILTERS.find((f) => f.key === active) || {}).label || '';
    list = `<div class="state">
      <p class="state-title">没有「${esc(label)}」的待办</p>
      <p>换一个筛选，或回到全部</p>
      <button class="btn" data-action="todo-filter" data-filter="all">看全部待办</button>
    </div>`;
  } else {
    list = `<div class="state"><p class="state-title">这一批都处理完了</p><p>还有 ${num(t.done.length)} 条在下面的已完成区</p></div>`;
  }

  return card + meta + todoFilterBar(pending) + list + (active === 'all' ? doneZone(t.done, t.stats.done) : '');
}

// ---------- 统计 ----------
function statsView() {
  const s = state.stats;
  if (!s.loaded && !s.error) return loadingBlock('正在统计…');
  if (s.error) return errorBlock(s.error, 'stats');

  const d = s.data || {};
  const c = d.counts || {};
  const f = d.funnel || {};
  if (!c.messages) {
    return emptyBlock('还没有数据', '先导入 QQ 导出的聊天记录并点「开始判断」', '去消息流', 'goto-messages');
  }

  // 大字口径按 SPEC §6：counts.messages → counts.todos；funnel 只作副标注
  const bigFrom = typeof c.messages === 'number' ? c.messages : f.messagesProcessed;
  const bigTo = typeof c.todos === 'number' ? c.todos : f.todosKept;
  const noiseNote = typeof c.messages === 'number' && typeof c.noise === 'number'
    ? `<p class="funnel-sub">其中 ${num(c.noise)} 条是闲聊，真正送去判定的 ${num(Math.max(0, c.messages - c.noise))} 条</p>`
    : '';

  const funnel = `<section class="funnel">
    <div class="funnel-big"><span class="n">${num(bigFrom)}</span><span class="arrow">→</span><span class="m">${num(bigTo)}</span></div>
    <p class="funnel-cap">条消息，最后真正留下来需要处理的</p>
    ${noiseNote}
  </section>`;

  const trio = `<div class="trio">
    <div class="t-pending"><b>${num(c.pending)}</b><small>待办</small></div>
    <div class="t-done"><b>${num(c.done)}</b><small>已完成</small></div>
    <div class="t-dismissed"><b>${num(c.dismissed)}</b><small>已排除</small></div>
  </div>`;

  const byGroup = (Array.isArray(d.byGroup) ? d.byGroup : [])
    .slice().sort((a, b) => (b.messages || 0) - (a.messages || 0));
  const maxMsg = Math.max(1, ...byGroup.map((g) => g.messages || 0));
  const groupPanel = byGroup.length ? `<section class="panel"><h2>按群分布</h2>${
    byGroup.map((g) => `<div class="grow">
      <span class="gname">${esc(g.groupName)}</span>
      <span class="gnum">${num(g.messages)} 消息 · ${num(g.todos)} 待办</span>
      <span class="gbar"><i style="width:${Math.max(2, Math.round(((g.messages || 0) / maxMsg) * 100))}%"></i></span>
    </div>`).join('')
  }</section>` : '';

  const due = Array.isArray(d.dueSoon) ? d.dueSoon : [];
  const duePanel = due.length ? `<section class="panel"><h2>即将到期</h2>${
    due.map((t) => {
      const left = typeof t.daysLeft === 'number' ? t.daysLeft : null;
      const label = left === null ? '' : left < 0 ? `已逾期 ${-left} 天` : left === 0 ? '今天到期' : `${left} 天后`;
      return `<div class="grow">
        <span class="gname">${esc(t.title)}</span>
        <span class="gnum">${esc(label)}</span>
      </div>`;
    }).join('')
  }</section>` : '';

  const last = d.lastExtract;
  const lastLine = last
    ? `上次判定 ${formatRelative(last.finishedAt || last.startedAt)} · 处理 ${num(last.processed)} 条 · 新建 ${num(last.todos)} 项`
    : '还没有跑过判定';

  return funnel + trio + groupPanel + duePanel + groupsPanel() + decisionsPanel() + pushPanel() + `<p class="meta">${esc(lastLine)}</p>`;
}

// ---------- 群设置（接口不存在时整块隐藏） ----------
const GROUP_MODES = [
  { key: 'normal', label: '正常' },
  { key: 'quiet', label: '安静' },
  { key: 'blocked', label: '屏蔽' },
];

function groupsPanel() {
  const g = state.groups;
  if (g.missing || !g.loaded) return '';
  if (g.error) {
    return `<section class="panel" id="groups-panel"><h2>群设置</h2><p class="meta">群设置没加载出来：${esc(g.error)}</p></section>`;
  }
  const items = Array.isArray(g.items) ? g.items : [];
  if (!items.length) return '';
  const rows = items.map((it) => {
    const name = String(it.groupName || '');
    const mode = String(it.mode || 'normal');
    const segs = GROUP_MODES.map((m) => `<button class="seg-btn${mode === m.key ? ' is-on' : ''}" data-action="group-mode"
      data-group="${esc(name)}" data-mode="${m.key}" aria-pressed="${mode === m.key ? 'true' : 'false'}">${m.label}</button>`).join('');
    return `<div class="gset" data-group="${esc(name)}">
      <div class="gset-main">
        <span class="gset-name" title="${esc(name)}">${esc(name)}</span>
        <span class="gset-num">${num(it.messages)} 消息 · ${num(it.todos)} 待办</span>
      </div>
      <div class="seg" role="group" aria-label="${esc(name)} 的设置">${segs}</div>
    </div>`;
  }).join('');
  return `<section class="panel" id="groups-panel"><h2>群设置</h2>${rows}</section>`;
}

// ---------- 最近的判断（接口不存在时整块隐藏） ----------
const VERDICT_LABELS = { todo: '待办', dropped: '丢弃', drop: '丢弃', noise: '闲聊', chat: '闲聊', ignored: '闲聊' };
const VERDICT_CLASS = { 待办: 'v-todo', 丢弃: 'v-dropped', 闲聊: 'v-noise' };

function decisionRow(it) {
  const raw = String(it.verdict || it.decision || it.kind || it.result || '').toLowerCase();
  const label = VERDICT_LABELS[raw] || (it.verdict || it.decision || '—');
  const cls = VERDICT_CLASS[label] || 'v-other';
  const group = String(it.groupName || it.group || (it.source && it.source.groupName) || '');
  const reason = String(it.reason || it.why || it.rationale || it.note || it.explain || '');
  const at = it.createdAt || it.at || it.ts || it.time || it.timestamp || '';
  const time = at ? formatRelative(at) : '';
  return `<li class="dec-row">
    <span class="dec-time">${esc(time || '—')}</span>
    <span class="dec-group" title="${esc(group)}">${esc(group || '未知群')}</span>
    <span class="dec-verdict ${cls}">${esc(label)}</span>
    <span class="dec-reason" title="${esc(reason)}">${esc(reason || '（无理由）')}</span>
  </li>`;
}

function decisionsPanel() {
  const d = state.decisions;
  if (d.missing || !d.loaded) return '';
  if (d.error) {
    return `<section class="panel" id="decisions-panel"><h2>最近的判断</h2><p class="meta">判断记录没加载出来：${esc(d.error)}</p></section>`;
  }
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 10);
  if (!items.length) return '';
  return `<section class="panel" id="decisions-panel"><h2>最近的判断</h2>
    <ul class="dec-list">${items.map(decisionRow).join('')}</ul></section>`;
}

// ---------- 到期提醒（Web Push；接口没上时整块隐藏） ----------
const PUSH_ENABLE_LABEL = '开启到期提醒';

function pushSupported() {
  return !!(navigator.serviceWorker && typeof window.PushManager === 'function' && 'Notification' in window);
}

function isIOSDevice() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

function isStandaloneMode() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (err) {
    // 老浏览器没有 matchMedia，当作非 standalone
  }
  return navigator.standalone === true;
}

// VAPID 公钥是 URL-safe base64，subscribe 要的是原始字节
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (String(base64String) + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function pushRegistration() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.ready) return null;
  try {
    return await withTimeout(navigator.serviceWorker.ready, 4000, null);
  } catch (err) {
    return null;
  }
}

function pushNote(p) {
  if (p.iosBlocked) return 'iPhone 需要先「添加到主屏幕」才能收到提醒';
  if (p.permission === 'denied') return '你之前拒绝过通知权限，需要在浏览器设置里改回来';
  if (p.subscription) return '已开启：待办临近截止时会推送到这台设备';
  return '开启后，临近截止的待办会走系统通知提醒你（锁屏也能看到）';
}

function pushPanel() {
  const p = state.push;
  if (p.missing) return '';
  if (!pushSupported()) {
    return `<section class="panel" id="push-panel"><h2>到期提醒</h2>
      <p class="meta">当前浏览器不支持锁屏提醒</p></section>`;
  }
  if (p.error) {
    return `<section class="panel" id="push-panel"><h2>到期提醒</h2>
      <p class="meta">到期提醒没加载出来：${esc(p.error)}</p></section>`;
  }
  if (!p.loaded) {
    return `<section class="panel" id="push-panel"><h2>到期提醒</h2>
      <p class="meta">正在检查推送状态…</p></section>`;
  }
  if (p.enabled === false) {
    return `<section class="panel" id="push-panel"><h2>到期提醒</h2>
      <p class="meta">服务端未配置推送密钥</p></section>`;
  }

  const busy = p.busy ? ' disabled' : '';
  const on = !!p.subscription;
  const blocked = !on && (p.permission === 'denied' || p.iosBlocked || p.busy);
  const actions = on
    ? `<button class="push-btn is-on" data-action="push-test"${busy}>发一条测试</button>
       <button class="push-btn" data-action="push-disable"${busy}>关闭</button>`
    : `<button class="push-btn is-primary" data-action="push-enable"${blocked ? ' disabled' : ''}>${PUSH_ENABLE_LABEL}</button>`;

  return `<section class="panel" id="push-panel"><h2>到期提醒</h2>
    <p class="meta push-note">${esc(pushNote(p))}</p>
    <div class="push-actions">${on ? '<span class="push-state">已开启</span>' : ''}${actions}</div>
  </section>`;
}

async function loadPush(quiet) {
  const p = state.push;
  if (!pushSupported()) {
    p.loaded = true;
    return;
  }
  if (!quiet) p.loading = true;
  try {
    const data = await api('/api/push/key');
    p.enabled = !(data && data.enabled === false);
    p.publicKey = (data && data.publicKey) || null;
    p.missing = false;
    p.error = null;
    p.iosBlocked = isIOSDevice() && !isStandaloneMode();
    p.permission = 'Notification' in window ? Notification.permission : 'default';
    if (p.enabled) {
      const reg = await pushRegistration();
      p.subscription = reg && reg.pushManager
        ? await reg.pushManager.getSubscription().catch(() => null)
        : null;
    }
    p.loaded = true;
  } catch (err) {
    p.loaded = true;
    if (err && err.status === 404) {
      p.missing = true;
    } else if (quiet) {
      throw err;
    } else {
      p.error = apiError(err);
    }
  }
  if (!quiet) render();
}

async function enablePush() {
  const p = state.push;
  if (p.busy) return;
  p.busy = true;
  render();
  try {
    if (!p.publicKey) throw new ApiError(0, '服务端还没给推送密钥');
    const reg = await pushRegistration();
    if (!reg || !reg.pushManager) throw new ApiError(0, '这个浏览器拿不到推送通道，无痕模式可能不支持');
    let perm = 'Notification' in window ? Notification.permission : 'default';
    if (perm !== 'granted') perm = await Notification.requestPermission();
    p.permission = perm;
    if (perm !== 'granted') {
      toast(perm === 'denied' ? '通知权限被拒绝，需要在浏览器设置里改回来' : '没有拿到通知权限', 'error');
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(p.publicKey),
    });
    const json = typeof sub.toJSON === 'function' ? sub.toJSON() : {};
    await api('/api/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: sub.endpoint,
        keys: json.keys || sub.keys || {},
        ua: String(navigator.userAgent || '').slice(0, 120),
      },
    });
    p.subscription = sub;
    toast('到期提醒已开启', 'ok');
  } catch (err) {
    toast(`开启失败：${apiError(err)}`, 'error');
  } finally {
    p.busy = false;
    render();
  }
}

async function disablePush() {
  const p = state.push;
  if (p.busy) return;
  p.busy = true;
  render();
  try {
    let sub = p.subscription;
    if (!sub) {
      const reg = await pushRegistration();
      sub = reg && reg.pushManager ? await reg.pushManager.getSubscription().catch(() => null) : null;
    }
    if (!sub) {
      p.subscription = null;
      toast('到期提醒已关闭', 'ok');
      return;
    }
    const endpoint = sub.endpoint;
    try {
      await sub.unsubscribe();
    } catch (err) {
      // 本地取消失败也要把服务端记录清掉，否则还会推过来
    }
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint } });
    p.subscription = null;
    toast('到期提醒已关闭', 'ok');
  } catch (err) {
    toast(`关闭失败：${apiError(err)}`, 'error');
  } finally {
    p.busy = false;
    render();
  }
}

async function testPush() {
  const p = state.push;
  if (p.busy) return;
  p.busy = true;
  render();
  try {
    const data = await api('/api/push/test', { method: 'POST', body: {} });
    const failed = data && data.failed ? `，失败 ${num(data.failed)} 台` : '';
    toast(`测试通知已发出：${num(data && data.sent)} 台${failed}`, 'ok');
  } catch (err) {
    toast(`发送失败：${apiError(err)}`, 'error');
  } finally {
    p.busy = false;
    render();
  }
}

// ---------- 渲染 ----------
function renderTabs() {
  document.querySelectorAll('.tab').forEach((el) => {
    const on = el.dataset.tab === state.tab;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function renderFoot() {
  const d = state.stats.data;
  $('#foot').textContent = d && d.provider ? `数据只存在本机 · 判定引擎 ${d.provider}` : '数据只存在本机';
}

function render() {
  renderTabs();
  if (state.tab === 'messages') view.innerHTML = messagesView();
  else if (state.tab === 'todos') view.innerHTML = todosView();
  else view.innerHTML = statsView();
  renderFoot();
  if (state.poll.armed) state.poll.lastSig = viewSignature();
}

function renderLive() {
  const el = $('#live-indicator');
  if (!el) return;
  const live = state.live || {};
  // 断网优先：轮询已停，告诉用户是在等网络而不是等服务器
  if (state.net.offline) {
    el.hidden = false;
    el.dataset.state = 'offline';
    el.classList.add('is-warn');
    el.innerHTML = '<span class="live-dot"></span>等待网络';
    el.setAttribute('title', '网络已断开，恢复后会自动续上');
    return;
  }
  if (live.enabled === false) { // 订阅没开：整块隐藏
    el.hidden = true;
    el.removeAttribute('data-state');
    return;
  }
  // 正在自动重试也算「重连中」，成功后回到「实时接收中」
  const connected = !!live.connected && state.retry.active === 0;
  el.hidden = false;
  el.dataset.state = connected ? 'connected' : 'reconnecting';
  el.classList.toggle('is-warn', !connected);
  el.innerHTML = `<span class="live-dot"></span>${connected ? '实时接收中' : '重连中'}`;
  el.setAttribute('title', state.retry.active > 0 ? '网络抖动，正在自动重试…' : liveTip(live, connected));
}

function minutesAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 1) return '刚刚';
  if (min < 120) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

function liveTip(live, connected) {
  const ago = live && live.lastEventAt ? minutesAgo(live.lastEventAt) : null;
  if (ago) return `最后收到消息：${ago}`;
  return connected ? '实时接收中' : '正在重连…';
}

// ---------- 抽屉 ----------
let lastFocus = null;

function findTodo(id) {
  return state.todos.pending.find((x) => x.id === id) || state.todos.done.find((x) => x.id === id) || null;
}

function renderDrawer() {
  const d = state.drawer;
  if (!d.open) return;
  const t = d.todo || {};
  const m = d.message;

  const bits = [];
  const groupName = (m && m.groupName) || (t.source && t.source.groupName) || '';
  const sender = (m && m.sender) || (t.source && t.source.sender) || '';
  const ts = (m && m.ts) || (t.source && t.source.ts) || '';
  if (groupName) bits.push(`<span class="src">${esc(groupName)}</span>`);
  if (sender) bits.push(`<span class="src">${esc(sender)}</span>`);
  if (ts) bits.push(`<span class="src">${esc(formatRelative(ts))}</span>`);

  const head = `${bits.length ? `<div class="drawer-meta">${bits.join('')}</div>` : ''}
    <h3 class="drawer-title">${esc(t.title || '（未命名待办）')}</h3>
    <div class="drawer-meta"><span class="badge-todo">待办</span><span class="deadline">${esc(deadlineLabel(t))}</span>${t.deadlineText ? `<span class="src">群里写作：${esc(t.deadlineText)}</span>` : ''}</div>
    ${imageThumb(m)}`;

  let content;
  if (d.loading) {
    content = loadingBlock('正在读取完整原文…');
  } else if (d.error) {
    content = `<div class="state state-error" role="alert">
      <p class="state-title">原文加载失败</p>
      <p class="state-msg">${esc(d.error)}</p>
      <button class="btn btn-sm" data-action="drawer-retry">重试</button>
    </div>`;
  } else if (m && typeof m.text === 'string') {
    content = `<div class="drawer-text" id="drawer-text">${esc(m.text)}</div>
      <p class="drawer-hint" id="drawer-len">原文共 ${m.text.length} 字，未截断</p>`;
  } else {
    content = `<div class="state">
      <p class="state-title">没有找到原始消息</p>
      <p>这条待办关联的消息可能已被清理，下面是判定信息。</p>
    </div>`;
  }

  const facts = [];
  if (Array.isArray(t.constraints) && t.constraints.length) {
    facts.push(`<div class="drawer-sec"><h3>约束要点</h3><div class="chips">${
      t.constraints.map((c) => `<span class="chip">${esc(c)}</span>`).join('')
    }</div></div>`);
  }
  if (t.reason) {
    facts.push(`<div class="drawer-sec"><h3>为什么算待办</h3><p>${esc(t.reason)}</p></div>`);
  }
  const info = [];
  if (typeof t.confidence === 'number') info.push(`置信度 ${Math.round(t.confidence * 100)}%`);
  if (t.model) info.push(`模型 ${t.model}`);
  if (t.status) info.push(`状态 ${STATUS_LABEL[t.status] || t.status}`);
  if (info.length) {
    facts.push(`<div class="drawer-sec"><h3>判定信息</h3><p>${esc(info.join(' · '))}</p></div>`);
  }

  // 群里没写日期的，自己补一个：补完就能进到期提醒和日历订阅
  if (t.status === 'pending') {
    facts.push(`<div class="drawer-sec"><h3>截止日期</h3>
      <div class="deadline-edit">
        <input type="date" id="drawer-deadline" value="${esc(isoDay(t.deadline) || '')}" aria-label="截止日期">
        <button class="btn btn-sm" data-action="deadline-save" data-id="${esc(t.id || '')}">保存</button>
        <button class="btn btn-sm btn-ghost" data-action="deadline-clear" data-id="${esc(t.id || '')}">清除</button>
      </div>
      <p class="drawer-hint">${t.deadlineManual ? '这个日期是你手动填的' : '留空表示没有截止日期；填了才会进提醒和日历'}</p>
    </div>`);
  }

  drawerBody.innerHTML = head + content + facts.join('');
}

async function openDrawer(id) {
  if (!id) return;
  lastFocus = document.activeElement;
  state.drawer = { open: true, id, todo: findTodo(id), message: null, loading: true, error: null };
  drawerEl.hidden = false;
  overlayEl.hidden = false;
  document.body.classList.add('no-scroll');
  renderDrawer();
  requestAnimationFrame(() => {
    drawerEl.classList.add('is-open');
    overlayEl.classList.add('is-open');
  });
  const closeBtn = $('#drawer-close');
  if (closeBtn) closeBtn.focus({ preventScroll: true });

  try {
    const data = await api(`/api/todos/${encodeURIComponent(id)}`);
    if (!state.drawer.open || state.drawer.id !== id) return;
    state.drawer.todo = data.todo || state.drawer.todo;
    state.drawer.message = data.message || null;
  } catch (err) {
    if (!state.drawer.open || state.drawer.id !== id) return;
    state.drawer.error = apiError(err);
  } finally {
    if (state.drawer.open && state.drawer.id === id) {
      state.drawer.loading = false;
      renderDrawer();
    }
  }
}

function closeDrawer() {
  state.drawer = { open: false, id: null, todo: null, message: null, loading: false, error: null };
  drawerEl.classList.remove('is-open');
  overlayEl.classList.remove('is-open');
  document.body.classList.remove('no-scroll');
  if (state.poll.dirty) { // 抽屉开着时攒下的刷新，关掉再补，避免底下列表在阅读中被重画
    state.poll.dirty = false;
    renderKeepScroll();
    state.poll.lastSig = viewSignature();
  }
  setTimeout(() => {
    if (!state.drawer.open) {
      drawerEl.hidden = true;
      overlayEl.hidden = true;
      drawerBody.innerHTML = '';
    }
  }, 280);
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
}

// ---------- 图片放大 ----------
let lightboxEl = null;
let lightboxImg = null;
let lightboxState = null;

function setLightboxState(s) {
  if (!lightboxEl || !lightboxState) return;
  lightboxEl.dataset.state = s;
  if (s === 'ready') {
    lightboxState.hidden = true;
  } else {
    lightboxState.hidden = false;
    lightboxState.textContent = s === 'error' ? '图片加载失败' : '正在加载图片…';
  }
}

function ensureLightbox() {
  if (lightboxEl) return lightboxEl;
  lightboxEl = document.createElement('div');
  lightboxEl.className = 'lightbox';
  lightboxEl.id = 'lightbox';
  lightboxEl.hidden = true;
  lightboxEl.setAttribute('role', 'dialog');
  lightboxEl.setAttribute('aria-modal', 'true');
  lightboxEl.setAttribute('aria-label', '图片预览');
  lightboxEl.innerHTML = `<button class="lightbox-close" type="button" data-action="zoom-close" aria-label="关闭图片">✕</button>
    <div class="lightbox-stage"></div>
    <p class="lightbox-state" role="status">正在加载图片…</p>`;
  document.body.appendChild(lightboxEl);

  lightboxState = $('.lightbox-state', lightboxEl);
  lightboxImg = document.createElement('img');
  lightboxImg.className = 'lightbox-img';
  lightboxImg.alt = '群消息图片';
  lightboxImg.addEventListener('load', () => { if (state.lightbox.open) setLightboxState('ready'); });
  lightboxImg.addEventListener('error', () => { if (state.lightbox.open) setLightboxState('error'); });
  $('.lightbox-stage', lightboxEl).appendChild(lightboxImg);

  // 点遮罩或空白舞台关闭；点图片本身不关
  lightboxEl.addEventListener('click', (event) => {
    const t = event.target;
    if (t === lightboxEl || (t instanceof Element && t.classList.contains('lightbox-stage'))) closeLightbox();
  });
  return lightboxEl;
}

function openLightbox(name) {
  if (!name) return;
  ensureLightbox();
  state.lightbox = { open: true, name };
  setLightboxState('loading');
  lightboxEl.hidden = false;
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => lightboxEl.classList.add('is-open'));
  lightboxImg.removeAttribute('src');
  lightboxImg.src = imageUrl(name);
  const btn = $('.lightbox-close', lightboxEl);
  if (btn) btn.focus({ preventScroll: true });
}

function closeLightbox() {
  if (!lightboxEl || !state.lightbox.open) return;
  state.lightbox = { open: false, name: '' };
  lightboxEl.classList.remove('is-open');
  if (!state.drawer.open) document.body.classList.remove('no-scroll');
  setTimeout(() => {
    if (state.lightbox.open) return;
    lightboxEl.hidden = true;
    lightboxImg.removeAttribute('src');
  }, 180);
  if (state.drawer.open) {
    const b = $('#drawer-close');
    if (b) b.focus({ preventScroll: true });
  }
}

// ---------- toast ----------
let toastTimer = null;

function toast(text, kind) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast is-open${kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-open');
    setTimeout(() => { if (!el.classList.contains('is-open')) el.hidden = true; }, 240);
  }, 3200);
}

// ---------- 数据加载 ----------
async function loadMessages(quiet) {
  if (!quiet) {
    state.messages.loading = true;
    state.messages.error = null;
    render();
  }
  try {
    const data = await api(`/api/messages?limit=${state.messages.limit}&noise=exclude`);
    state.messages.items = Array.isArray(data.items) ? data.items : [];
    state.messages.groups = Array.isArray(data.groups) ? data.groups : [];
    state.messages.total = typeof data.total === 'number' ? data.total : state.messages.items.length;
    cancelAutoRetry('messages');
  } catch (err) {
    if (quiet) throw err;
    state.messages.error = loadErrorText(err);
    if (isRetryable(err)) scheduleAutoRetry('messages');
  } finally {
    if (!quiet) {
      state.messages.loading = false;
      state.messages.loaded = true;
      render();
    }
  }
}

async function loadMoreMessages() {
  if (state.messages.loading) return;
  const keepY = window.scrollY; // 渲染会重建 DOM，加载更多后停回原位
  state.messages.limit += MESSAGE_PAGE;
  await loadMessages();
  window.scrollTo(0, keepY);
}

async function loadTodos(quiet) {
  if (!quiet) {
    state.todos.loading = true;
    state.todos.error = null;
    render();
  }
  try {
    const [pendingRes, doneRes] = await Promise.all([
      api('/api/todos?status=pending&limit=200'),
      api('/api/todos?status=done&limit=200').catch(() => ({ items: [] })),
    ]);
    const byId = new Map();
    [...(pendingRes.items || []), ...(doneRes.items || [])].forEach((t) => {
      if (t && t.id && !byId.has(t.id)) byId.set(t.id, t);
    });
    const all = [...byId.values()];
    state.todos.pending = all.filter((t) => t.status !== 'done' && t.status !== 'dismissed');
    state.todos.done = all.filter((t) => t.status === 'done');
    const st = pendingRes.stats || doneRes.stats || {};
    state.todos.stats = {
      pending: typeof st.pending === 'number' ? st.pending : state.todos.pending.length,
      done: typeof st.done === 'number' ? st.done : state.todos.done.length,
      dismissed: typeof st.dismissed === 'number' ? st.dismissed : 0,
    };
    cancelAutoRetry('todos');
  } catch (err) {
    if (quiet) throw err;
    state.todos.error = loadErrorText(err);
    if (isRetryable(err)) scheduleAutoRetry('todos');
  } finally {
    if (!quiet) {
      state.todos.loading = false;
      state.todos.loaded = true;
      render();
      // 完成度卡片要用 /api/stats 的 counts；拿不到就自动隐藏，不阻塞待办列表
      if (!state.stats.loaded && !state.stats.loading) loadStats();
    }
  }
}

async function loadStats(quiet) {
  if (!quiet) {
    state.stats.loading = true;
    state.stats.error = null;
    render();
  }
  try {
    state.stats.data = await api('/api/stats');
    cancelAutoRetry('stats');
  } catch (err) {
    if (quiet) throw err;
    state.stats.error = loadErrorText(err);
    if (isRetryable(err)) scheduleAutoRetry('stats');
  } finally {
    if (!quiet) {
      state.stats.loading = false;
      state.stats.loaded = true;
      render();
    }
  }
}

async function loadGroups(quiet) {
  if (!quiet) {
    state.groups.loading = true;
    state.groups.error = null;
  }
  try {
    const data = await api('/api/groups');
    state.groups.items = Array.isArray(data && data.items) ? data.items : [];
    state.groups.missing = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      state.groups.missing = true; // 接口还没上线：整块隐藏，不报错
    } else if (quiet) {
      throw err;
    } else {
      state.groups.error = apiError(err);
    }
  } finally {
    if (!quiet) {
      state.groups.loading = false;
      state.groups.loaded = true;
      render();
    }
  }
}

async function loadDecisions(quiet) {
  if (!quiet) {
    state.decisions.loading = true;
    state.decisions.error = null;
  }
  try {
    const data = await api('/api/decisions?limit=10');
    state.decisions.items = Array.isArray(data && data.items) ? data.items : (Array.isArray(data) ? data : []);
    state.decisions.missing = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      state.decisions.missing = true;
    } else if (quiet) {
      throw err;
    } else {
      state.decisions.error = apiError(err);
    }
  } finally {
    if (!quiet) {
      state.decisions.loading = false;
      state.decisions.loaded = true;
      render();
    }
  }
}

async function setGroupMode(name, mode) {
  const label = (GROUP_MODES.find((m) => m.key === mode) || {}).label || mode;
  try {
    const data = await api(`/api/groups/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    });
    const items = Array.isArray(state.groups.items) ? state.groups.items : [];
    const saved = (data && (data.group || data.item)) || null;
    const hit = items.find((x) => String(x.groupName || '') === name);
    if (hit) {
      hit.mode = (saved && saved.mode) || mode;
      if (saved && typeof saved.messages === 'number') hit.messages = saved.messages;
      if (saved && typeof saved.todos === 'number') hit.todos = saved.todos;
    } else if (saved) items.push(saved);
    toast(`已设为${label}`, 'ok');
    render();
    // 静音/屏蔽会影响消息流与待办台的内容，切完必须重新取一遍
    loadMessages();
    loadTodos();
    loadStats();
    loadDecisions();
  } catch (err) {
    toast(`设置失败：${apiError(err)}`, 'error');
  }
}

async function loadLive(quiet) {
  try {
    state.live = await api('/api/live');
  } catch (err) {
    state.live = null;
    renderLive();
    if (quiet) throw err;
    return;
  }
  renderLive();
}

// ---------- 自动刷新 ----------
// 页面可见时每 20 秒刷一次 /api/live + /api/stats + 当前 tab 的列表；
// 失败按 20s → 40s → 60s 退避，成功一次就复位；上一轮没回来不发下一轮。
const POLL_LADDER = [20000, 40000, 60000];

function viewSignature() {
  const s = state;
  return JSON.stringify([
    s.tab, s.filters,
    s.messages.items, s.messages.total,
    s.todos.pending, s.todos.done, s.todos.stats,
    s.stats.data, s.groups.items, s.decisions.items,
  ]);
}

function renderKeepScroll() {
  const y = window.scrollY;
  const act = document.activeElement;
  const focusId = act && act.id ? act.id : null;
  const caret = focusId && 'selectionStart' in act ? act.selectionStart : null;
  render();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && el !== document.activeElement) {
      try {
        el.focus({ preventScroll: true });
        if (caret != null && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret, caret);
      } catch (err) { /* 焦点恢复失败不影响内容 */ }
    }
  }
  if (Math.abs(window.scrollY - y) >= 1) window.scrollTo(0, y);
}

// 数据没变不重渲染；抽屉开着先记账，关抽屉时补一次
function renderIfChanged() {
  const next = viewSignature();
  if (next === state.poll.lastSig) return false;
  if (state.drawer.open) {
    state.poll.dirty = true;
    return false;
  }
  renderKeepScroll();
  state.poll.lastSig = next;
  return true;
}

function pollDelay() {
  return POLL_LADDER[Math.min(state.poll.fails, POLL_LADDER.length - 1)];
}

function schedulePoll(delay) {
  clearTimeout(state.poll.timer);
  state.poll.timer = setTimeout(pollOnce, typeof delay === 'number' ? delay : pollDelay());
}

function pollTargets() {
  const jobs = [loadLive(true), loadStats(true)];
  if (state.tab === 'messages') jobs.push(loadMessages(true));
  else if (state.tab === 'todos') jobs.push(loadTodos(true));
  else jobs.push(loadGroups(true), loadDecisions(true));
  return jobs;
}

async function pollOnce() {
  if (state.poll.running || document.hidden || state.net.offline) return;
  state.poll.running = true;
  state.poll.ticks += 1;
  let failed = false;
  try {
    const results = await Promise.allSettled(pollTargets());
    failed = results.some((r) => r.status === 'rejected');
  } catch (err) {
    failed = true;
  } finally {
    state.poll.running = false;
    state.poll.fails = failed ? Math.min(state.poll.fails + 1, POLL_LADDER.length) : 0;
    renderIfChanged();
    // 断网时不再排下一轮，等 online 事件把轮询叫醒
    if (!document.hidden && !state.net.offline) schedulePoll();
  }
}

// 断网/恢复：offline 停轮询并显示「等待网络」，online 立刻补一轮（含失败的首屏）
function startNetworkWatch() {
  const wake = () => {
    state.poll.fails = 0;
    clearTimeout(state.poll.timer);
    state.poll.timer = null;
    if (state.messages.error) retry('messages');
    if (state.todos.error) retry('todos');
    if (state.stats.error) retry('stats');
    pollOnce();
  };
  window.addEventListener('offline', () => {
    state.net.offline = true;
    clearTimeout(state.poll.timer);
    state.poll.timer = null;
    renderLive();
  });
  window.addEventListener('online', () => {
    state.net.offline = false;
    wake();
  });
  if (navigator.onLine === false) state.net.offline = true;
}

function startAutoRefresh() {
  state.poll.armed = true;
  state.poll.lastSig = viewSignature();
  schedulePoll();
  startNetworkWatch();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.poll.timer);
      state.poll.timer = null;
      return;
    }
    state.poll.fails = 0; // 回到前台先立刻刷一次，退避也一并复位
    clearTimeout(state.poll.timer);
    pollOnce();
  });
}

// ---------- 动作 ----------
function applyStatus(id, status, serverTodo) {
  const before = findTodo(id);
  if (!before && !serverTodo) return;
  const merged = { ...(before || {}), ...(serverTodo || {}), status };
  const wasDismissed = !before && status === 'dismissed';

  state.todos.pending = state.todos.pending.filter((x) => x.id !== id);
  state.todos.done = state.todos.done.filter((x) => x.id !== id);

  if (merged.status === 'done') state.todos.done.unshift(merged);
  else if (merged.status === 'pending') state.todos.pending.unshift(merged);

  state.todos.stats = {
    pending: state.todos.pending.length,
    done: state.todos.done.length,
    dismissed: state.todos.stats.dismissed + (merged.status === 'dismissed' && !wasDismissed ? 1 : 0),
  };
  render();
}

async function setStatus(id, status, btn) {
  if (!id) return;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    const data = await api(`/api/todos/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    applyStatus(id, status, data.todo);
    toast(status === 'done' ? '已移到已完成' : status === 'dismissed' ? '已标记为不是待办' : '已恢复到待办', 'ok');
    if (state.stats.loaded) loadStats();
  } catch (err) {
    toast(`操作失败：${apiError(err)}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

async function snoozeTodo(id, preset, btn) {
  if (!id) return;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    // server-b 的契约：PATCH { snooze: tomorrow | 3d | 1w | tonight }
    const data = await api(`/api/todos/${encodeURIComponent(id)}`, { method: 'PATCH', body: { snooze: preset } });
    applySnooze(id, data && data.todo, preset);
    state.snooze.openId = null;
    render();
    const merged = findTodo(id);
    const until = merged ? snoozeISO(merged) : '';
    toast(until ? `已推后到 ${shortDate(until)}` : '已推后', 'ok');
    if (state.stats.loaded) loadStats();
  } catch (err) {
    toast(`推后失败：${apiError(err)}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

// 后端没回新截止日时，前端按预设兜一个日期，保证徽标和分组立刻正确
function applySnooze(id, serverTodo, preset) {
  const before = findTodo(id);
  if (!before) return;
  const merged = { ...before, ...(serverTodo || {}) };
  state.todos.pending = state.todos.pending.map((x) => (x.id === id ? merged : x));
  if (!snoozeISO(merged)) {
    const days = { tomorrow: 1, '3d': 3, '1w': 7, tonight: 0 }[preset];
    if (typeof days === 'number') state.snoozed[id] = isoAddDays(todayISO(), days);
  }
}

// 手动设/清截止日：群里没写日期时，用户自己补一个，补完才进提醒与日历
async function saveDeadline(id, value, btn) {
  if (!id) return;
  const day = isoDay(value);
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    const data = await api(`/api/todos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { deadline: day || null },
    });
    const next = (data && data.todo) || null;
    if (next) {
      state.todos.pending = state.todos.pending.map((x) => (x.id === id ? { ...x, ...next } : x));
      if (state.drawer.open && state.drawer.id === id) state.drawer.todo = { ...state.drawer.todo, ...next };
    }
    render();
    renderDrawer();
    toast(day ? `截止日期已设为 ${shortDate(day)}` : '已清除截止日期', 'ok');
    if (state.stats.loaded) loadStats();
  } catch (err) {
    toast(`保存失败：${apiError(err)}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

async function runExtract() {  if (state.busy.extract) return;
  state.busy.extract = true;
  render();
  try {
    const data = await api('/api/extract', { method: 'POST', body: {} });
    const errs = Array.isArray(data.errors) ? data.errors.length : 0;
    toast(`判断完成：处理 ${num(data.processed)} 条，新增 ${num(data.todosCreated)} 项待办${errs ? `（${errs} 条出错）` : ''}`, 'ok');
    state.messages.loaded = false;
    state.todos.loaded = false;
    state.stats.loaded = false;
    await switchTab('todos');
    loadMessages();
    loadStats();
  } catch (err) {
    toast(`判断失败：${apiError(err)}`, 'error');
  } finally {
    state.busy.extract = false;
    render();
  }
}

async function onFileChosen(file) {
  if (!file) return;
  state.busy.ingest = true;
  render();
  try {
    const content = await file.text();
    const data = await api('/api/ingest', { method: 'POST', body: { filename: file.name, content } });
    const warn = Array.isArray(data.warnings) && data.warnings.length ? `（${data.warnings.length} 条警告）` : '';
    toast(`已导入 ${num(data.imported)} 条${data.skipped ? `，跳过 ${num(data.skipped)} 条` : ''}${warn}`, 'ok');
    state.messages.loaded = false;
    state.todos.loaded = false;
    state.stats.loaded = false;
    await loadMessages();
  } catch (err) {
    toast(`导入失败：${apiError(err)}`, 'error');
  } finally {
    state.busy.ingest = false;
    fileInput.value = '';
    render();
  }
}

async function ensureTabData(tab) {
  if (tab === 'messages' && (!state.messages.loaded || state.messages.error)) await loadMessages();
  if (tab === 'todos' && (!state.todos.loaded || state.todos.error)) await loadTodos();
  // 待办台要判「原文含 @全体」，顺手把首屏消息拉一次，不必等用户切过去
  if (tab === 'todos' && !state.messages.loaded && !state.messages.loading) loadMessages();
  if (tab === 'stats' && (!state.stats.loaded || state.stats.error)) await loadStats();
  if (tab === 'stats') {
    if (!state.groups.loaded && !state.groups.loading) loadGroups();
    if (!state.decisions.loaded && !state.decisions.loading) loadDecisions();
    if (!state.push.loaded && !state.push.loading) loadPush();
  }
}

async function switchTab(tab) {
  if (!tab) return;
  state.snooze.openId = null;
  state.tab = tab;
  render();
  window.scrollTo(0, 0);
  await ensureTabData(tab);
}

function retry(target) {
  cancelAutoRetry(target);
  if (target === 'messages') {
    state.messages.loaded = false;
    loadMessages();
  } else if (target === 'todos') {
    state.todos.loaded = false;
    loadTodos();
  } else if (target === 'stats') {
    state.stats.loaded = false;
    loadStats();
  } else {
    location.reload();
  }
}

// ---------- 事件 ----------
function bind() {
  // 推后菜单：点空白处收起（捕获阶段先跑，避免重渲染把这次点击吃掉）
  document.addEventListener('click', (event) => {
    if (!state.snooze.openId) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('.snooze-wrap')) return;
    state.snooze.openId = null;
    document.querySelectorAll('.snooze-menu').forEach((el) => el.remove());
    document.querySelectorAll('.snooze-btn.is-open').forEach((el) => {
      el.classList.remove('is-open');
      el.setAttribute('aria-expanded', 'false');
    });
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const tabEl = target.closest('.tab');
    if (tabEl && tabEl.dataset.tab) {
      switchTab(tabEl.dataset.tab);
      return;
    }

    const actEl = target.closest('[data-action]');
    if (!actEl) return;

    const action = actEl.dataset.action;
    const id = actEl.dataset.id;

    // 演示站只读：写操作一律拦下并说明原因，不静默失败
    if (IS_DEMO && DEMO_WRITE_ACTIONS.has(action)) {
      toast(DEMO_READONLY_TIP, 'info');
      return;
    }

    switch (action) {
      case 'import': fileInput.click(); break;
      case 'guide-bot': toast('机器人接入：先把 NapCat 跑起来，再把通知转发给机器人小号（详见仓库 README）', 'info'); break;
      case 'extract': runExtract(); break;
      case 'done': setStatus(id, 'done', actEl); break;
      case 'restore': setStatus(id, 'pending', actEl); break;
      case 'dismiss': setStatus(id, 'dismissed', actEl); break;
      case 'open': openDrawer(id); break;
      case 'more-messages': loadMoreMessages(); break;
      case 'close-drawer': closeDrawer(); break;
      case 'zoom-image': openLightbox(actEl.dataset.img); break;
      case 'zoom-close': closeLightbox(); break;
      case 'drawer-retry': openDrawer(state.drawer.id); break;
      case 'deadline-save': {
        const input = document.getElementById('drawer-deadline');
        saveDeadline(id, input ? input.value : '', actEl);
        break;
      }
      case 'deadline-clear': {
        const input = document.getElementById('drawer-deadline');
        if (input) input.value = '';
        saveDeadline(id, '', actEl);
        break;
      }
      case 'retry': retry(actEl.dataset.target); break;
      case 'goto-messages': switchTab('messages'); break;
      case 'goto-todos': switchTab('todos'); break;
      case 'todo-filter': state.filters.todo = actEl.dataset.filter || 'all'; render(); break;
      case 'snooze-menu': state.snooze.openId = state.snooze.openId === id ? null : id; render(); break;
      case 'snooze': snoozeTodo(id, actEl.dataset.preset, actEl); break;
      case 'group-mode': setGroupMode(actEl.dataset.group || '', actEl.dataset.mode || 'normal'); break;
      case 'push-enable': enablePush(); break;
      case 'push-disable': disablePush(); break;
      case 'push-test': testPush(); break;
      case 'clear-search': state.filters.msgQ = ''; render(); break;
      case 'clear-filters': state.filters.msgQ = ''; state.filters.msgGroup = ''; render(); break;
      default: break;
    }
  });

  // 检索即时生效：只重绘结果区，输入框保持焦点
  view.addEventListener('input', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || el.id !== 'msg-search') return;
    state.filters.msgQ = el.value;
    const wrap = el.closest('.search');
    if (wrap) wrap.classList.toggle('has-value', !!el.value);
    refreshMessageResults();
  });

  view.addEventListener('change', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLSelectElement) || el.id !== 'msg-group') return;
    state.filters.msgGroup = el.value;
    refreshMessageResults();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    onFileChosen(file);
  });

  overlayEl.addEventListener('click', closeDrawer);

  // 缩略图加载失败 → 降级成一行灰字，别留白框
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('msg-img')) return;
    const wrap = img.closest('.msg-img-wrap');
    if (!wrap) return;
    wrap.classList.add('is-error');
    img.hidden = true;
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.lightbox.open) { closeLightbox(); return; }
      if (state.drawer.open) closeDrawer();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLImageElement
      && event.target.classList.contains('msg-img')) {
      event.preventDefault();
      openLightbox(event.target.dataset.img);
    }
  });
}

function registerSW() {
  if (IS_DEMO) return; // 演示站不装 SW，免得把只读演示的壳缓存到真实站的 scope 上
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 注册失败不影响页面主流程
    });
  });
}

// 装到桌面：安卓走 beforeinstallprompt，iOS 只能给「分享 → 添加到主屏幕」的指引。
// 顶栏常驻一个「装到桌面」按钮——紫条可以被关掉，这个按钮不会消失，用户永远找得到入口。
function setupInstall() {
  const hint = document.getElementById('install-hint');
  const textEl = document.getElementById('install-text');
  const btn = document.getElementById('install-btn');
  const closeBtn = document.getElementById('install-close');
  const cta = document.getElementById('install-cta');
  if (!hint || !textEl || !btn || !closeBtn || !cta) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
    || window.navigator.standalone === true;
  if (standalone) return;

  const DISMISS_KEY = 'qqtd.installHint.dismissed';
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInApp = /MicroMessenger|QQ\/|Weibo|AlipayClient|DingTalk|vivo.*Office|VivoBrowser.*Office/i.test(ua);

  let deferred = null;
  let shown = false;

  const guideText = () => {
    if (isInApp) return '点右上角 ··· →「在浏览器打开」，再从浏览器菜单装到桌面';
    if (isIOS) return '点底部「分享」→「添加到主屏幕」，以后像 App 一样打开';
    return '点右上角菜单（⋮ / ≡）→「安装应用」或「添加到主屏幕」';
  };

  const setCta = () => {
    cta.hidden = false;
    cta.textContent = deferred ? '一键装到桌面' : '怎么装到桌面';
    cta.classList.toggle('is-ready', !!deferred);
  };

  const show = (text) => {
    if (text) textEl.textContent = text;
    hint.hidden = false;
    shown = true;
  };
  const hide = () => {
    hint.hidden = true;
  };
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* 隐私模式忽略 */ }
    hide();
  };

  closeBtn.addEventListener('click', dismiss);

  const promptInstall = async () => {
    if (!deferred) return;
    btn.disabled = true;
    try {
      deferred.prompt();
      const result = await deferred.userChoice;
      if (result && result.outcome === 'accepted') dismiss();
    } catch { /* 用户取消或浏览器不支持，保持原样 */ }
    deferred = null;
    btn.hidden = true;
    btn.disabled = false;
    setCta();
  };

  btn.addEventListener('click', promptInstall);

  cta.addEventListener('click', async () => {
    if (deferred) {
      await promptInstall();
      return;
    }
    // 没有原生安装事件：把指引再拿出来，并清掉「别再打扰我」的标记
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* 同上 */ }
    btn.hidden = true;
    show(guideText());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  setCta();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    setCta();
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
    textEl.textContent = '把它装到桌面，以后不用再输网址';
    btn.hidden = false;
    show();
  });

  window.addEventListener('appinstalled', () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* 同上 */ }
    hide();
    cta.hidden = true;
    toast('已装到桌面', 'ok');
  });

  let dismissed = false;
  try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch { dismissed = false; }

  window.setTimeout(() => {
    if (dismissed || shown || deferred) return;
    btn.hidden = true;
    show(guideText());
  }, 1800);
}

// 自报一次「这次是从桌面图标开的，还是浏览器里开的」——服务端据此判断安装是否真的生效。
function reportPresence() {
  if (IS_DEMO) return; // 演示站只读：presence 是 POST，会被 405 挡下并脏控制台
  const mq = (q) => {
    try { return window.matchMedia(q).matches; } catch { return false; }
  };
  const standalone = mq('(display-mode: standalone)') || mq('(display-mode: minimal-ui)') || window.navigator.standalone === true;
  const display = mq('(display-mode: standalone)') ? 'standalone'
    : mq('(display-mode: minimal-ui)') ? 'minimal-ui'
      : mq('(display-mode: fullscreen)') ? 'fullscreen'
        : 'browser';
  try {
    fetch('./api/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ standalone, display, w: window.innerWidth, h: window.innerHeight }),
      keepalive: true,
    }).catch(() => { /* 上报失败不影响使用 */ });
  } catch { /* 同上 */ }
}

async function boot() {
  bind();
  markDemo();
  render();
  registerSW();
  setupInstall();
  reportPresence();
  loadLive();
  await loadMessages();
  startAutoRefresh();
}

// 演示站：顶栏挂一枚「演示」角标，顺带把标题标清楚，别让人以为这是自己的数据
function markDemo() {
  if (!IS_DEMO) return;
  document.body.classList.add('is-demo');
  document.title = 'QQ 待办台 · 在线演示';
  const bar = document.querySelector('.topbar');
  if (!bar || bar.querySelector('.demo-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'demo-badge';
  badge.textContent = '演示';
  badge.title = '演示站只读，数据是示例数据';
  const cta = bar.querySelector('.install-cta');
  if (cta) bar.insertBefore(badge, cta);
  else bar.appendChild(badge);
}

boot().catch((err) => {
  view.innerHTML = errorBlock(apiError(err), 'boot');
});

