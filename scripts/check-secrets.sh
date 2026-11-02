#!/usr/bin/env bash
# 薄包装：真正的逻辑在 scripts/check-secrets.mjs（Windows / Linux / CI 共用一份实现）。
# 用法：bash scripts/check-secrets.sh   —— 命中任何真实标识即非零退出。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/check-secrets.mjs "$@"
