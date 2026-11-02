#!/bin/bash
# 只装「每周复盘」这一个定时器；每日摘要（qq-todo-notify.timer）与备份不在这里动。
set -e

echo '=== 1) 安装 unit ==='
install -m 644 /opt/qq-todo/deploy/qq-todo-weekly.service /etc/systemd/system/qq-todo-weekly.service
install -m 644 /opt/qq-todo/deploy/qq-todo-weekly.timer /etc/systemd/system/qq-todo-weekly.timer
systemctl daemon-reload

echo
echo '=== 2) 启用定时器 ==='
systemctl enable --now qq-todo-weekly.timer >/dev/null 2>&1 || true
systemctl list-timers qq-todo-weekly.timer --no-pager | head -3

echo
echo '=== 3) 干跑（只打印，不发送） ==='
set -a
# shellcheck disable=SC1091
. /opt/qq-todo/.env
set +a
set -u
/usr/bin/node /opt/qq-todo/deploy/weekly-digest.mjs --dry-run

echo
echo '=== 4) 立即触发一次真实推送（要发就取消下面一行的注释） ==='
# systemctl start qq-todo-weekly.service && journalctl -u qq-todo-weekly.service -n 20 --no-pager
