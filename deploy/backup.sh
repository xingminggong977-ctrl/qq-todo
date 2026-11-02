#!/usr/bin/env bash
# 每日备份。<DATA_DIR> 下所有文件打成一个 tar.gz —— 业务数据只有 store.json，
# 但把目录整体打包，将来多出 runs/、logs/ 之类也不用改脚本。
# store.json 是「临时文件 + rename」原子替换（src/store.js:223-224），所以打包时读到的永远是完整文件，
# 不需要额外加锁或快照接口。
# 任何一步失败都以非零退出，交给 systemd 记进 journal 并标红。
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/qq-todo/data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/qq-todo}"
KEEP_DAYS="${KEEP_DAYS:-7}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
STAMP="$(date +%Y%m%d)"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() {
  printf '[%s] 错误：%s\n' "$(date '+%F %T')" "$*" >&2
  exit 1
}

# 校验一段 store.json 文本：必须是对象，四个数组字段都在，回显计数供对账。
verify_json() {
  "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let state;
      try {
        state = JSON.parse(raw);
      } catch (err) {
        console.error("store.json 不是合法 JSON：" + err.message);
        process.exit(2);
      }
      for (const key of ["messages", "todos", "runs", "corrections"]) {
        if (!Array.isArray(state[key])) {
          console.error("store.json 缺少数组字段：" + key);
          process.exit(3);
        }
      }
      process.stdout.write(`messages=${state.messages.length} todos=${state.todos.length} runs=${state.runs.length}`);
    });
  '
}

[ -d "$DATA_DIR" ] || die "数据目录不存在：$DATA_DIR"
[ -f "$DATA_DIR/store.json" ] || die "找不到 $DATA_DIR/store.json"
[ -n "$NODE_BIN" ] || die "找不到 node，无法校验 store.json（可用 NODE_BIN 指定绝对路径）"

mkdir -p "$BACKUP_DIR" || die "无法创建备份目录：$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

dst="$BACKUP_DIR/$STAMP.tar.gz"
tmp="$BACKUP_DIR/.$STAMP.tar.gz.tmp"

# 1) 备份前先证明源文件可解析；坏文件照样打包只会生产一份没用的备份
before="$(verify_json <"$DATA_DIR/store.json")" || die "源 store.json 完整性检查失败，本次不产出备份"

# 2) 打包整个数据目录；.tmp 是 store.js 写入过程中的临时文件，不该进备份
rm -f "$tmp"
tar -czf "$tmp" -C "$DATA_DIR" --exclude='*.tmp' . || die "打包失败：$DATA_DIR"

# 3) 校验归档：store.json 必须在包里，且解出来的内容与备份前计数完全一致
#    注意：不能用 `tar -tzf | grep -qx` —— grep -q 命中后立即关管道，tar 收到 SIGPIPE 退出 141，
#    在 `set -o pipefail` 下整条管道被判失败（2026-11-01 线上实测踩到）。改为先取全量列表再匹配。
listing="$(tar -tzf "$tmp")" || die "无法列出归档内容：$tmp"
case $'\n'"$listing"$'\n' in
  *$'\n'./store.json$'\n'*) : ;;
  *) die "归档里没有 store.json" ;;
esac
after="$(tar -xzOf "$tmp" ./store.json | verify_json)" || die "归档内的 store.json 校验失败"
[ "$before" = "$after" ] || die "归档内容与源文件计数不一致：源[$before] 包[$after]"

mv -f "$tmp" "$dst" || die "落盘失败：$dst"
chmod 600 "$dst" 2>/dev/null || true
log "已备份 $DATA_DIR -> $dst（$(wc -c <"$dst") 字节，$after）"

# 保留策略按文件名里的日期判断（不看 mtime：cp/rsync 改时间戳会让清理逻辑失真）
cutoff="$(date -d "-$KEEP_DAYS days" +%Y%m%d)"
for file in "$BACKUP_DIR"/*.tar.gz; do
  [ -e "$file" ] || continue
  base="$(basename "$file")"
  day="${base%%.*}"
  case "$day" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) continue ;;
  esac
  if [ "$day" -lt "$cutoff" ]; then
    rm -f "$file"
    log "已清理过期备份 $base（保留 $KEEP_DAYS 天）"
  fi
done

log "备份目录当前内容："
ls -l "$BACKUP_DIR" >&2 || true
