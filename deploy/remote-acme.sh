#!/bin/bash
# 1) 部署 index/config/push 三个文件 2) 打开 acme webroot 3) 补 .env 4) 起服并验证
set -e
cd /opt/qq-todo
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/qq-todo-backup
tar -czf "/root/qq-todo-backup/pre-acme-$TS.tgz" src data .env 2>/dev/null || true

tar -xzf /root/acme.tgz
node --check src/server/index.js
node --check src/config.js
node --check src/server/push.js

mkdir -p /var/www/acme
chmod 755 /var/www/acme

python3 - <<'PY'
import re
p = '/opt/qq-todo/.env'
s = open(p, encoding='utf-8').read()
if 'ACME_WEBROOT=' not in s:
    if not s.endswith('\n'):
        s += '\n'
    s += 'ACME_WEBROOT=/var/www/acme\n'
    open(p, 'w', encoding='utf-8').write(s)
    print('env appended ACME_WEBROOT')
else:
    print('env already has ACME_WEBROOT')
PY

systemctl restart qq-todo
sleep 3
systemctl is-active qq-todo
echo "== listeners =="
ss -lntp | grep -E ':(80|443|7788|7789)\b' | awk '{print $4, $6}'
echo "== acme challenge 路由 =="
echo "acme-test-$TS" > /var/www/acme/probe.txt
curl -s -m 6 "http://127.0.0.1/.well-known/acme-challenge/probe.txt" || echo "(empty)"
curl -s -o /dev/null -m 6 -w "traversal:%{http_code}\n" "http://127.0.0.1/.well-known/acme-challenge/..%2f..%2fetc%2fpasswd"
curl -s -o /dev/null -m 6 -w "missing:%{http_code}\n" "http://127.0.0.1/.well-known/acme-challenge/nope.txt"
curl -s -o /dev/null -m 6 -w "normal-redirect:%{http_code}\n" "http://127.0.0.1/api/health"
