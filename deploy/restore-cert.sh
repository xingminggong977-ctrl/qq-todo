#!/bin/bash
# 救火：acme.sh 的 --install-cert 偶尔会把 fullchain.pem 写成 0 字节。
# 这时别急着重签（会吃 Let's Encrypt 的频率限制），先用 acme.sh 自己目录里的历史证书补回去。
#
# 用法：DOMAIN=todo.example.com ./restore-cert.sh
# 可选变量：ACME、CERT_DIR、APP_DIR、SERVICE
set -euo pipefail

DOMAIN="${DOMAIN:?请先指定 DOMAIN，例如 DOMAIN=todo.example.com}"
ACME="${ACME:-$HOME/.acme.sh}"
CERT_DIR="${CERT_DIR:-/etc/qq-todo/cert}"
APP_DIR="${APP_DIR:-/opt/qq-todo}"
SERVICE="${SERVICE:-qq-todo}"

cp -f "$ACME/$DOMAIN/fullchain.cer" "$CERT_DIR/fullchain.pem"
cp -f "$ACME/$DOMAIN/$DOMAIN.key" "$CERT_DIR/privkey.pem"
chmod 600 "$CERT_DIR/privkey.pem"
ls -l "$CERT_DIR/"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -dates

systemctl restart "$SERVICE"
sleep 3
systemctl is-active "$SERVICE"
ss -lntp | grep -E ':(443|80)\b' || echo "NO TLS LISTENER"

T=$(grep '^AUTH_TOKEN=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || true)
curl -sk -o /dev/null -m 8 -w "443-with-token:%{http_code}\n" "https://127.0.0.1/api/health?t=$T"
curl -sk -o /dev/null -m 8 -w "443-no-token:%{http_code}\n" "https://127.0.0.1/api/health"
