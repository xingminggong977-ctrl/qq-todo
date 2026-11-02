#!/bin/bash
# 只装「新待办即时提醒」这两个 unit；已有的 notify / remind / weekly 一个字都不动。
# 注意：脚本必须跑在 deploy/ 目录里（它的 import 是相对 deploy/ 写的），不要平铺到项目根。
set -e

NODE=/usr/local/bin/node
APP_DIR=/opt/qq-todo
SCRIPT="$APP_DIR/deploy/notify-new.mjs"

if [ ! -x "$NODE" ]; then echo "找不到 $NODE，退出"; exit 1; fi
if [ ! -f "$SCRIPT" ]; then echo "缺少 $SCRIPT，退出"; exit 1; fi

echo '=== 0) 清掉历史误拷贝的平铺副本（import 会在那里断掉） ==='
if [ -f "$APP_DIR/notify-new.mjs" ]; then
  rm -f "$APP_DIR/notify-new.mjs"
  echo "  已删除 $APP_DIR/notify-new.mjs"
else
  echo "  无残留"
fi

echo
echo '=== 1) 安装 unit ==='
install -m 644 "$APP_DIR/deploy/qq-todo-notify-new.service" /etc/systemd/system/qq-todo-notify-new.service
install -m 644 "$APP_DIR/deploy/qq-todo-notify-new.timer" /etc/systemd/system/qq-todo-notify-new.timer
systemctl daemon-reload

echo
echo '=== 2) 启用定时器 ==='
systemctl enable --now qq-todo-notify-new.timer >/dev/null 2>&1 || true
systemctl list-timers qq-todo-notify-new.timer --no-pager | head -3

echo
echo '=== 3) 干跑（只打印，不发送、不写状态） ==='
set -a
# shellcheck disable=SC1091
. "$APP_DIR/.env"
set +a
DRY_RUN=1 "$NODE" "$SCRIPT"

echo
echo '=== 4) 立即真跑一次（要发就取消下面一行的注释） ==='
# systemctl start qq-todo-notify-new.service && journalctl -u qq-todo-notify-new.service -n 20 --no-pager
