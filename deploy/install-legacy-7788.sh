#!/bin/bash
# 旧手机图标仍指向 :7788（origin 变了就得重装 PWA），用 socat 做 TLS 透传，把它桥到 443。
set -e
cat > /etc/systemd/system/qq-todo-legacy-7788.service <<'UNIT'
[Unit]
Description=qq-todo legacy 7788 -> 443 TLS passthrough
After=network.target qq-todo.service
Wants=qq-todo.service

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:7788,fork,reuseaddr TCP:127.0.0.1:443
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now qq-todo-legacy-7788.service
sleep 2
systemctl is-active qq-todo-legacy-7788.service
ss -lntp | grep ':7788' || true
echo "== legacy 7788 =="
curl -sk -o /dev/null -m 8 -w "no-token:%{http_code}\n" https://127.0.0.1:7788/api/health
echo "== 443 / 80 =="
T=$(grep '^AUTH_TOKEN=' /opt/qq-todo/.env | cut -d= -f2)
curl -sk -o /dev/null -m 8 -w "443-with-token:%{http_code}\n" "https://127.0.0.1:443/api/health?t=$T"
curl -s -o /dev/null -m 8 -w "80-redirect:%{http_code} %{redirect_url}\n" "http://127.0.0.1:80/?t=$T"
