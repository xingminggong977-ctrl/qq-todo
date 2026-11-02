#!/bin/bash
# 切换对外地址（备案通过后把 PUBLIC_URL 切回自己的域名，或换任意新域名）
#
#   ./switch-public-url.sh https://todo.example.com
#
# 做的事：校验 URL → 改 /opt/qq-todo/.env 的 PUBLIC_URL → 重启服务 → 用本机 curl 验收 → 打印手机链接与二维码路径。
# 证书仍按 SNI 的证书 SAN 自动选择（src/server/index.js 的 certHosts/matchHost），
# 所以切域名前要确保该域名的证书已经放进 TLS_CERT/TLS_KEY 或 TLS_ALT_CERT/TLS_ALT_KEY。
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/qq-todo}
ENV_FILE="$APP_DIR/.env"
URL=${1:-}

if [[ -z "$URL" ]]; then
  echo "用法：$0 https://todo.example.com" >&2
  exit 2
fi
if [[ ! "$URL" =~ ^https?://[A-Za-z0-9._-]+(:[0-9]+)?$ ]]; then
  echo "URL 不合法（不要带路径或问号）：$URL" >&2
  exit 2
fi
[[ -f "$ENV_FILE" ]] || { echo "找不到 $ENV_FILE" >&2; exit 1; }

HOSTPORT=${URL#*://}
HOST=${HOSTPORT%%:*}
TOKEN=$(grep -E '^AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
[[ -n "$TOKEN" ]] || { echo "读取 AUTH_TOKEN 失败" >&2; exit 1; }

echo "=== 0) 先看一眼这个域名能不能解析 ==="
getent hosts "$HOST" || { echo "解析失败：$HOST 没有 A 记录，先加解析再切" >&2; exit 1; }

echo "=== 1) 改 PUBLIC_URL ==="
cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
if grep -qE '^PUBLIC_URL=' "$ENV_FILE"; then
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=$URL#" "$ENV_FILE"
else
  echo "PUBLIC_URL=$URL" >> "$ENV_FILE"
fi
grep -E '^PUBLIC_URL=' "$ENV_FILE"

echo "=== 2) 重启 ==="
systemctl restart qq-todo
sleep 2
systemctl is-active qq-todo

echo "=== 3) 验收（从本机连自己）==="
code=$(curl -sk -o /dev/null -w '%{http_code}' "$URL/api/stats?t=$TOKEN" || echo 000)
echo "  $URL/api/stats → $code"
[[ "$code" == "200" ]] || { echo "切过去之后 200 没拿到，先别推广新地址；旧配置备份在 $ENV_FILE.bak.*" >&2; exit 1; }

echo "=== 4) 手机入口 ==="
echo "  $URL/?t=$TOKEN"
echo -n "  二维码："
node -e "
const QR = require('$APP_DIR/node_modules/qrcode');
QR.toFile('$APP_DIR/qr-public.png', process.argv[1], { width: 900, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0f0e14', light: '#ffffff' } })
  .then(() => console.log('$APP_DIR/qr-public.png'));
" "$URL/?t=$TOKEN"

echo "=== 5) 记得回去更新浏览器里已装的那个图标（旧图标还指着老地址）==="
