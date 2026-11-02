import os from 'node:os';
import QRCode from 'qrcode';

// 超过这个行数就不是「扫一眼」而是刷屏了，直接降级成地址。
const MAX_QR_LINES = 60;

export function findLanIp(interfaces = os.networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const info of entries ?? []) {
      if (info && info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

export function normalizePublicUrl(raw, port) {
  let text = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  const url = new URL(text);
  const explicitPort = url.port ? `:${url.port}` : '';
  const defaultPort = url.protocol === 'https:' || Number(port) === 80;
  const suffix = explicitPort || (defaultPort ? '' : `:${port}`);
  const basePath = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.hostname}${suffix}${basePath}`;
}

export function resolveAddresses({ env, port, interfaces }) {
  const token = String(env.AUTH_TOKEN ?? '').trim();
  const local = `http://127.0.0.1:${port}`;
  const lanIp = findLanIp(interfaces);
  const rawPublicUrl = String(env.PUBLIC_URL ?? '').trim();

  let base = null;
  let publicUrlError = null;
  if (rawPublicUrl) {
    try {
      base = normalizePublicUrl(rawPublicUrl, port);
    } catch {
      publicUrlError = rawPublicUrl;
    }
  }
  if (!base && lanIp) base = `http://${lanIp}:${port}`;

  const mobile = base ? (token ? `${base}/?t=${encodeURIComponent(token)}` : base) : null;
  return { local, mobile, lanIp, publicUrl: rawPublicUrl, publicUrlError };
}

export async function renderQr(url, log = console.log) {
  try {
    const text = await QRCode.toString(url, { type: 'terminal', small: true });
    const lines = text.split('\n').filter((line) => line.trim() !== '').length;
    if (lines > MAX_QR_LINES) {
      log('（二维码太大，终端放不下，请直接打开上面的「手机」地址）');
      return false;
    }
    log(text.replace(/\s+$/, ''));
    return true;
  } catch (err) {
    // URL 超过二维码容量时 qrcode 会抛错，按 SPEC §7 只打地址。
    log(`（二维码生成失败：${err?.message ?? err}；请直接打开上面的「手机」地址）`);
    return false;
  }
}

export async function printBanner({ env, port, log = console.log, interfaces }) {
  const info = resolveAddresses({ env, port, interfaces });
  const token = String(env.AUTH_TOKEN ?? '').trim();
  const live = String(env.LIVE_ENABLED ?? '').toLowerCase() === 'on';

  log(`QQ 待办台 v1.0.0  ·  模型 ${env.LLM_PROVIDER || 'stub'}  ·  实时 ${live ? 'on' : 'off'}`);
  log(`数据目录： ${env.DATA_DIR || './data'}`);

  if (info.publicUrlError) {
    log(`PUBLIC_URL 不是合法地址（${info.publicUrlError}），已忽略`);
  }

  if (info.mobile) {
    log(`本机： ${info.local}`);
    log(`手机： ${info.mobile}`);
  } else {
    log(`本机： ${info.local}`);
    log('未取到局域网 IPv4，手机暂时连不上；可用 PUBLIC_URL 指定公网地址，或检查网卡。');
  }

  const demoOn = String(env.DEMO_ENABLED ?? 'on').toLowerCase() !== 'off';
  if (demoOn) log(`演示： ${info.local}/demo/（只读，免口令）`);

  if (!token) log('提示：AUTH_TOKEN 为空，同网段任何人都能打开这个页面。');
  if (String(env.HOST ?? '') === '127.0.0.1' && info.mobile) {
    log('提示：HOST=127.0.0.1 只监听回环，手机需要用 HOST=0.0.0.0 才能连。');
  }

  if (info.mobile) {
    log('');
    await renderQr(info.mobile, log);
  }
  return info;
}
