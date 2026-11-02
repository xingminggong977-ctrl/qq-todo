import { Buffer } from 'node:buffer';

// 统一用 { error: { code, message } } 形状，SPEC §4。
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendError(res, status, code, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: { code, message } });
}

export const BODY_LIMIT = 8 * 1024 * 1024;

// 超限时不再缓存分片，但继续把流读干净，否则客户端收不到 413。
export function readRawBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'payload_too_large', `请求体超过 ${limit} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

export async function readJsonBody(req, limit = BODY_LIMIT) {
  const buf = await readRawBody(req, limit);
  const text = buf.toString('utf8').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_request', '请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_request', '请求体必须是 JSON 对象');
  }
  return parsed;
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key || key in out) continue;
    let value = part.slice(idx + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* 坏 cookie 保持原样即可 */
    }
    out[key] = value;
  }
  return out;
}
