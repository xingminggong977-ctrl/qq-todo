#!/bin/bash
# 到期提醒定时器：每天 08:05 与 20:00 各推一次（手机锁屏也能收到）
# 依赖：/opt/qq-todo/.env 里的 AUTH_TOKEN 与 VAPID_*；服务监听 127.0.0.1:7789
set -e

TOKEN=$(grep '^AUTH_TOKEN=' /opt/qq-todo/.env | cut -d= -f2)
if [ -z "$TOKEN" ]; then echo "AUTH_TOKEN 缺失，退出"; exit 1; fi

cat > /etc/systemd/system/qq-todo-remind.service <<UNIT
[Unit]
Description=QQ 待办台 · 到期提醒推送
After=qq-todo.service

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -fsS -X POST "http://127.0.0.1:7789/api/push/remind?t=${TOKEN}"
UNIT

cat > /etc/systemd/system/qq-todo-remind-morning.timer <<'UNIT'
[Unit]
Description=QQ 待办台 · 早间到期提醒（08:05）

[Timer]
OnCalendar=*-*-* 08:05:00
Persistent=true
Unit=qq-todo-remind.service

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/qq-todo-remind-evening.timer <<'UNIT'
[Unit]
Description=QQ 待办台 · 晚间到期提醒（20:00）

[Timer]
OnCalendar=*-*-* 20:00:00
Persistent=true
Unit=qq-todo-remind.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now qq-todo-remind-morning.timer qq-todo-remind-evening.timer
systemctl list-timers --all --no-pager | grep -E 'remind|NEXT'
echo "== 手动跑一次 =="
systemctl start qq-todo-remind.service
sleep 3
journalctl -u qq-todo-remind.service --no-pager -n 5
