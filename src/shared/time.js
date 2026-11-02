// 时间口径：一律北京时间（固定 +8，无夏令时），输出 "YYYY-MM-DD"。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function toMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    // NapCat 的 time 是秒；毫秒（>1e11）也接受
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return toMs(n);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

export function todayISO(now = Date.now()) {
  const p = beijingParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function daysLeft(dateStr, today = todayISO()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? "").trim());
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m || !t) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const base = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  return Math.round((target - base) / DAY_MS);
}

export function formatRelative(iso, now = Date.now()) {
  const ms = toMs(iso);
  if (ms === null) return "";
  const d = beijingParts(ms);
  const n = beijingParts(now);
  const hhmm = `${pad2(d.hour)}:${pad2(d.minute)}`;
  const dToday = Date.UTC(n.year, n.month - 1, n.day);
  const dThat = Date.UTC(d.year, d.month - 1, d.day);
  const diffDays = Math.round((dToday - dThat) / DAY_MS);
  if (diffDays === 0) return `今天 ${hhmm}`;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  return `${pad2(d.month)}-${pad2(d.day)} ${hhmm}`;
}

// 解析导出文件里的时间戳，缺年时用 fallbackYear 补。
export function parseBeijingDateTime(text, fallbackYear = null) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  const withYear = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (withYear) return buildISO(+withYear[1], +withYear[2], +withYear[3], +withYear[4], +withYear[5], +(withYear[6] || 0));
  const noYear = /^(\d{1,2})[-/月](\d{1,2})[日]?[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (noYear && fallbackYear) {
    return buildISO(fallbackYear, +noYear[1], +noYear[2], +noYear[3], +noYear[4], +(noYear[5] || 0));
  }
  return null;
}

export function buildISO(year, month, day, hour = 0, minute = 0, second = 0) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59) || !(second >= 0 && second <= 59)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`;
}
