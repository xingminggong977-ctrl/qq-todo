#!/bin/bash
# 只装「到期提醒走 QQ」这三个 unit；已有的 qq-todo-remind*.{service,timer}（Web Push 版）一个字都不动。
set -e

NODE=/usr/local/bin/node
APP_DIR=/opt/qq-todo

if [ ! -x "$NODE" ]; then echo "找不到 $NODE，退出"; exit 1; fi
if [ ! -f "$APP_DIR/remind.mjs" ]; then
  if [ -f "$APP_DIR/deploy/remind.mjs" ]; then
    # unit 里写的是 /opt/qq-todo/remind.mjs；仓库里它在 deploy/，这里补一份到平铺位置（幂等）
    cp "$APP_DIR/deploy/remind.mjs" "$APP_DIR/remind.mjs"
    cp "$APP_DIR/deploy/notify.mjs" "$APP_DIR/notify.mjs"
  else
    echo "缺少 $APP_DIR/remind.mjs（也不在 $APP_DIR/deploy/ 下），退出"; exit 1
  fi
fi

echo '=== 1) 安装 unit ==='
install -m 644 "$APP_DIR/deploy/qq-todo-qq-remind.service" /etc/systemd/system/qq-todo-qq-remind.service
install -m 644 "$APP_DIR/deploy/qq-todo-qq-remind-morning.timer" /etc/systemd/system/qq-todo-qq-remind-morning.timer
install -m 644 "$APP_DIR/deploy/qq-todo-qq-remind-evening.timer" /etc/systemd/system/qq-todo-qq-remind-evening.timer
systemctl daemon-reload

echo
echo '=== 2) 启用定时器 ==='
systemctl enable --now qq-todo-qq-remind-morning.timer qq-todo-qq-remind-evening.timer >/dev/null 2>&1 || true
systemctl list-timers 'qq-todo-qq-remind-*' --no-pager | head -4

echo
echo '=== 3) 干跑（只打印，不发送；DRY_RUN=1 优先级高于 unit 里的真实发送） ==='
set -a
# shellcheck disable=SC1091
. "$APP_DIR/.env"
set +a
DRY_RUN=1 "$NODE" "$APP_DIR/remind.mjs"

echo
echo '=== 4) 立即真发一条（要发就取消下面一行的注释） ==='
# systemctl start qq-todo-qq-remind.service && journalctl -u qq-todo-qq-remind.service -n 20 --no-pager
