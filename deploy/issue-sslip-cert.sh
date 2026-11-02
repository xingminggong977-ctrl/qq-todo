#!/bin/bash
# 用 acme.sh 走 80 口 http-01 签一张证书，签完重启服务。
#
# 没有域名、只想用 IP 访问时，可以用 sslip.io 这类公共通配 DNS：
# 把 1.2.3.4 映射成 1-2-3-4.sslip.io，于是 IP 也能拿到受信任证书。
#
# 用法：
#   DOMAIN=todo.example.com ./issue-sslip-cert.sh
#   DOMAIN=1-2-3-4.sslip.io EXTRA_SAN=todo.example.com ./issue-sslip-cert.sh
#
# 可选变量：ACME（acme.sh 路径）、CERT_DIR（证书落盘目录）、WEBROOT（http-01 校验目录）、SERVICE
set -euo pipefail

ACME="${ACME:-$HOME/.acme.sh/acme.sh}"
CERT_DIR="${CERT_DIR:-/etc/qq-todo/cert}"
WEBROOT="${WEBROOT:-/var/www/acme}"
SERVICE="${SERVICE:-qq-todo}"
EXTRA_SAN="${EXTRA_SAN:-}"
: "${DOMAIN:?请先指定 DOMAIN，例如 DOMAIN=todo.example.com}"

SAN_ARGS=()
if [ -n "$EXTRA_SAN" ]; then
  SAN_ARGS=(-d "$EXTRA_SAN")
fi

"$ACME" --issue -d "$DOMAIN" "${SAN_ARGS[@]}" \
  --webroot "$WEBROOT" --server letsencrypt --keylength 2048 --force 2>&1 | tail -16

echo "== install =="
mkdir -p "$CERT_DIR"
"$ACME" --install-cert -d "$DOMAIN" \
  --key-file "$CERT_DIR/privkey.pem" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --reloadcmd "systemctl restart $SERVICE" 2>&1 | tail -6

echo "== cert names =="
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text | grep -A2 'Subject Alternative Name'
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -dates
