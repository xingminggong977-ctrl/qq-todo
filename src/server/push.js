// Web Push 的服务端封装：VAPID 签名、批量发送、死订阅清理、到期文案生成。
// 独立成一层的原因：发送是「尽力而为」——任何一次失败都不该把请求或定时任务带崩。
import defaultWebpush from 'web-push';

const SUBJECT_DEFAULT = 'mailto:admin@example.com';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LINES = 3;
const MAX_BODY_CHARS = 120;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 订阅既可能以 store 里的记录（含 id）出现，也可能是裸 PushSubscription；统一成发送要的形状。
function toTarget(item) {
  if (!item || typeof item !== 'object') return null;
  const endpoint = text(item.endpoint);
  const keys = item.keys ?? {};
  const p256dh = text(keys.p256dh);
  const auth = text(keys.auth);
  if (!endpoint || !p256dh || !auth) return null;
  return { id: text(item.id) || endpoint, endpoint, keys: { p256dh, auth } };
}

function beijingDay(nowMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

// 只比日期，不比时刻：deadline 是 YYYY-MM-DD，换算成 UTC 零点再相减，避免夏令时/时区干扰。
function dayDiff(deadline, today) {
  const a = Date.parse(`${deadline}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / DAY_MS);
}

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

// 正文是多行，不能像标题那样把换行压成空格，否则「最多 3 条」会变成一行糊在一起
function clipBody(value, max) {
  const s = String(value ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function isSnoozed(todo, nowMs) {
  if (!todo?.snoozedUntil) return false;
  const until = Date.parse(todo.snoozedUntil);
  return Number.isFinite(until) && until > nowMs;
}

// 三档：已逾期 → 今天 → 明天。标题按最高优先级那一档说话，正文最多三行。
export function buildReminder(todos, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const today = beijingDay(Number.isFinite(nowMs) ? nowMs : Date.now());
  const buckets = { overdue: [], today: [], tomorrow: [] };
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (!todo || todo.status !== 'pending') continue;
    if (isSnoozed(todo, nowMs)) continue;
    const deadline = text(todo.deadline).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) continue;
    const diff = dayDiff(deadline, today);
    if (diff === null) continue;
    if (diff < 0) buckets.overdue.push({ todo, deadline, diff });
    else if (diff === 0) buckets.today.push({ todo, deadline, diff });
    else if (diff === 1) buckets.tomorrow.push({ todo, deadline, diff });
  }
  const count = buckets.overdue.length + buckets.today.length + buckets.tomorrow.length;
  if (count === 0) return null;

  buckets.overdue.sort((a, b) => a.diff - b.diff);
  const ordered = [...buckets.overdue, ...buckets.today, ...buckets.tomorrow];

  let title;
  if (buckets.overdue.length) title = `有 ${buckets.overdue.length} 件事已逾期`;
  else if (buckets.today.length) title = `今天有 ${buckets.today.length} 件事要交`;
  else title = `明天到期 ${buckets.tomorrow.length} 件`;

  const lines = ordered.slice(0, MAX_LINES).map(({ todo, diff }) => {
    const name = clip(todo.title ?? todo.deadlineText ?? '（无标题）', 24);
    return diff < 0 ? `${name} · 已逾期 ${Math.abs(diff)} 天` : `${name} · 截止 ${text(todo.deadline)}`;
  });
  if (ordered.length > MAX_LINES) lines.push(`…还有 ${ordered.length - MAX_LINES} 件`);
  const body = clipBody(lines.join('\n'), MAX_BODY_CHARS);
  return { title, body, count };
}

export function createPush({ env = {}, store = null, log = console, webpush = defaultWebpush } = {}) {
  // loadEnv 只回 DEFAULTS 白名单里的键，VAPID_* 不在里面，所以必须回落 process.env
  // （.env 里的值由 loadEnv 写进 process.env，两种来源都能覆盖到）
  const pick = (key) => text(env[key]) || text(process.env[key]);
  const publicKeyText = pick('VAPID_PUBLIC_KEY');
  const privateKeyText = pick('VAPID_PRIVATE_KEY');
  const subject = pick('VAPID_SUBJECT') || SUBJECT_DEFAULT;
  const enabled = Boolean(publicKeyText && privateKeyText);
  let vapidReady = false;

  function warn(...args) {
    try {
      (log?.warn ?? log?.error ?? console.warn)(...args);
    } catch {
      // 日志本身出错也不能影响发送结果
    }
  }

  // setVapidDetails 只在第一次发送前调用；密钥写错也只影响推送，不影响服务本身。
  function ensureVapid() {
    if (!enabled || vapidReady) return enabled;
    try {
      webpush.setVapidDetails(subject, publicKeyText, privateKeyText);
      vapidReady = true;
    } catch (err) {
      warn('[push] VAPID 初始化失败', err?.message ?? err);
    }
    return enabled;
  }

  async function listSubscriptions() {
    try {
      const result = await store?.listPushSubscriptions?.();
      const items = Array.isArray(result) ? result : result?.items;
      return Array.isArray(items) ? items : [];
    } catch (err) {
      warn('[push] 读取订阅失败', err?.message ?? err);
      return [];
    }
  }

  async function removeSubscription(target) {
    try {
      if (typeof store?.removePushSubscription === 'function') await store.removePushSubscription(target.id);
    } catch (err) {
      warn('[push] 删除失效订阅失败', err?.message ?? err);
    }
  }

  const disabledResult = () => ({ sent: 0, failed: 0, removed: 0, total: 0, disabled: true });

  async function send(payload = {}) {
    if (!enabled) return disabledResult();
    ensureVapid();
    const items = await listSubscriptions();
    const body = JSON.stringify({
      title: clip(payload.title ?? '', 60) || '待办提醒',
      body: String(payload.body ?? '').slice(0, 400),
      url: text(payload.url) || '/',
      at: new Date().toISOString(),
    });
    let sent = 0;
    let failed = 0;
    let removed = 0;
    for (const item of items) {
      const target = toTarget(item);
      if (!target) continue;
      try {
        await webpush.sendNotification({ endpoint: target.endpoint, keys: target.keys }, body, { TTL: 3600 });
        sent += 1;
      } catch (err) {
        const status = Number(err?.statusCode ?? err?.status ?? 0);
        // 404/410 是浏览器明确说「这个订阅没了」，留着只会每次都失败一次
        if (status === 404 || status === 410) {
          removed += 1;
          await removeSubscription(target);
        } else {
          failed += 1;
          warn('[push] 发送失败', status || err?.message || err);
        }
      }
    }
    const total = Math.max(0, items.length - removed);
    return { sent, failed, removed, total };
  }

  return {
    enabled,
    publicKey: () => (enabled ? publicKeyText : ''),
    send,
    async remind({ todos = [], now = Date.now() } = {}) {
      const reminder = buildReminder(todos, now);
      return reminder ? { ...reminder } : null;
    },
    // 供 /api/health 直接读，免得业务层再猜订阅数
    async subscriptionCount() {
      return (await listSubscriptions()).length;
    },
  };
}
