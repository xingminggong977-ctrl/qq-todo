#!/bin/bash
# 备份一次 → 用真包做一次恢复演练 → 安装每日定时器 → 重启服务并自查 /api/health。
# 所有路径都能用环境变量覆盖，默认值就是 deploy/README.md 里给出的安装布局。
#
#   APP_DIR      代码与数据所在目录   (默认 /opt/qq-todo)
#   BACKUP_DIR   备份包输出目录       (默认 /var/backups/qq-todo)
#   SERVICE      systemd 服务名       (默认 qq-todo)
#
# 用法：sudo APP_DIR=/srv/qq-todo bash deploy/install-backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/qq-todo}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/qq-todo}"
SERVICE="${SERVICE:-qq-todo}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ]; then echo "找不到 node，退出" >&2; exit 1; fi
if [ ! -f "$APP_DIR/.env" ]; then echo "缺少 $APP_DIR/.env，先按 deploy/README.md 配好再跑" >&2; exit 1; fi
mkdir -p "$BACKUP_DIR"

echo '=== 1) 备份 ==='
DATA_DIR="$APP_DIR/data" BACKUP_DIR="$BACKUP_DIR" bash "$APP_DIR/deploy/backup.sh"

echo
echo '=== 2) 恢复演练（真解包 + 真起实例 + counts 对账） ==='
LATEST="$(ls -1t "$BACKUP_DIR"/*.tar.gz | head -1)"
echo "latest=$LATEST"
"$NODE_BIN" "$APP_DIR/deploy/restore-drill.mjs" "$LATEST"

echo
echo '=== 3) 安装每日定时器 ==='
install -m 644 "$APP_DIR/deploy/qq-todo-backup.service" /etc/systemd/system/qq-todo-backup.service
install -m 644 "$APP_DIR/deploy/qq-todo-backup.timer" /etc/systemd/system/qq-todo-backup.timer
systemctl daemon-reload
systemctl enable --now qq-todo-backup.timer >/dev/null 2>&1 || true
systemctl list-timers qq-todo-backup.timer --no-pager | head -3

echo
echo '=== 4) 重启服务 + health 自查 ==='
systemctl restart "$SERVICE"
sleep 3
systemctl is-active "$SERVICE"

# AUTH_TOKEN 只从 .env 读，绝不写进脚本：留空时服务本身不鉴权，带不带 t= 都是 200。
TOKEN="$(grep -m1 '^AUTH_TOKEN=' "$APP_DIR/.env" | cut -d= -f2- || true)"
URL="http://127.0.0.1:7789/api/health"  # 明文口仅本机监听，不依赖 7788 的 socat 透传
if [ -n "$TOKEN" ]; then
  echo -n 'health(带 token)='; curl -s -o /tmp/qq-todo-health.json -w '%{http_code}\n' "$URL?t=$TOKEN"
  echo -n 'token 回显检查: '
  if grep -Eq "$TOKEN" /tmp/qq-todo-health.json; then echo "LEAK!!"; else echo clean; fi
else
  echo -n 'health(无 token)='; curl -s -o /tmp/qq-todo-health.json -w '%{http_code}\n' "$URL"
  echo '（AUTH_TOKEN 为空，跳过 token 回显检查）'
fi
head -c 600 /tmp/qq-todo-health.json
echo

