# 运维手册 · 备份 / 恢复 / 健康检查 / 日志

面向 your-server 上的 `/opt/qq-todo`。除标注 scp 的几步，其余命令都在服务器上执行。

## 0. 先认清数据在哪

存储是**单文件 JSON**，不是 SQLite：

```
/opt/qq-todo/data/store.json      # 全部消息 / 待办 / 运行记录
/opt/qq-todo/data/presence.log    # 实时订阅的在场记录，可丢
```

典型布局：

```
$ ls -la /opt/qq-todo/data/
-rw-r--r-- 1 root root   3778 Nov  1 19:41 presence.log
-rw-r--r-- 1 root root 149139 Nov  1 19:53 store.json
$ find /opt/qq-todo -name '*.db'          # 无输出：没有 SQLite 库
$ find /opt/qq-todo -name '*.sqlite*'     # 无输出
```

写入方式是**原子替换**（`src/store.js:223-224`：先 `writeFileSync(tmpFile)` 再 `renameSync(tmpFile, file)`），
所以备份时直接读文件、打包目录都不会拿到半个文件，不需要额外加锁，也不用给 store 加什么快照接口。

## 1. 每日备份

### 做法

把整个 `$DATA_DIR` 打成 `YYYYMMDD.tar.gz` 落到 `/var/backups/qq-todo/`，保留 7 天。
打包而不是只拷 `store.json`，是为了将来目录里多出 `runs/`、`logs/` 之类时不用改脚本。

### 安装（一次性）

```bash
scp deploy/backup.sh         root@your-server:/opt/qq-todo/deploy/backup.sh
scp deploy/restore-drill.mjs root@your-server:/opt/qq-todo/deploy/restore-drill.mjs
scp deploy/qq-todo-backup.service deploy/qq-todo-backup.timer \
    root@your-server:/etc/systemd/system/

ssh root@your-server '
  chmod +x /opt/qq-todo/deploy/backup.sh &&
  systemctl daemon-reload &&
  systemctl enable --now qq-todo-backup.timer'
```

### 验证

```bash
/opt/qq-todo/deploy/backup.sh                  # 手工跑一次
ls -l /var/backups/qq-todo                     # 应出现 YYYYMMDD.tar.gz
systemctl list-timers qq-todo-backup.timer     # NEXT 应是次日 03:20 附近
journalctl -u qq-todo-backup -n 30             # 能看到 messages=… todos=… runs=…
```

### 行为

| 项 | 值 |
| --- | --- |
| 打包内容 | `$DATA_DIR` 全部文件，排除 `*.tmp`（store.json 写入过程的临时文件） |
| 落盘位置 | `/var/backups/qq-todo/YYYYMMDD.tar.gz`，目录 700、文件 600 |
| 触发 | 每天 03:20，`RandomizedDelaySec=600` 错峰，`Persistent=true` 关机后补跑 |
| 保留 | 7 天，按文件名日期清理（不看 mtime，`cp -p` 打不乱） |
| 幂等 | 同一天重跑覆盖当天归档 |
| 校验 | 打包前 `JSON.parse` 源 store.json；打包后再从归档里 `tar -xzO` 解出 store.json 再 `JSON.parse` 一次，两次计数必须完全相等 |
| 失败 | 任一步失败非零退出 + stderr 原因，systemd 记为 failed；校验不过时**不产出**半吊子备份 |
| 不含 | `.env`（token 与密钥刻意不进备份目录），换机时请单独保管 |

## 2. 恢复

### 2.1 恢复演练（先做这个）

```bash
node /opt/qq-todo/deploy/restore-drill.mjs /var/backups/qq-todo/20261101.tar.gz
```

它做四件事：解包到临时目录 → 用临时端口起一个真实实例（`DATA_DIR` 指向解包目录、只监听 127.0.0.1、
`AUTH_TOKEN` 置空仅为演练免 token）→ `curl /api/stats` → 断言 `counts` 与备份里的数组长度逐项一致 → 关掉并清理。
输出形如：

```
PASS 解包目录        /tmp/qq-todo-drill-XXXX
PASS 临时实例        http://127.0.0.1:7801/api/stats 已响应
PASS 备份内计数      messages=220 todos=39 pending=39 done=0
PASS 服务自报计数    messages=220 todos=39 pending=39 done=0
PASS 恢复演练        counts 逐项一致，备份可用于真实恢复
```

### 2.2 真实恢复

```bash
systemctl stop qq-todo
mv /opt/qq-todo/data /opt/qq-todo/data.before-restore-$(date +%s)
mkdir -p /opt/qq-todo/data
tar -xzf /var/backups/qq-todo/20261101.tar.gz -C /opt/qq-todo/data
chown -R root:root /opt/qq-todo/data
systemctl start qq-todo
TOKEN=$(sed -n 's/^AUTH_TOKEN=//p' /opt/qq-todo/.env)
curl -s "http://127.0.0.1:7789/api/health?t=$TOKEN"
```

`counts.messages` / `counts.todos` 与备份时一致即视为恢复成功。旧目录留着，确认没问题再删。

## 3. `/api/health` 扩展字段

字段**只增不改**：原有 `ok` / `version` / `provider` / `counts` 与状态码语义保持原样。

| 字段 | 含义 |
| --- | --- |
| `storeBytes` | `store.json` 当前字节数（读不到时 0） |
| `messages` / `todos` | 消息数 / 待办数（与 `counts` 同源，方便只看顶层） |
| `lastExtract` | 最近一次抽取的 `{durationMs, costUsd, provider}`，没抽过是 `null` |
| `liveConnected` | 实时订阅是否连着；订阅器没启用或抛错一律 `false` |
| `diskFreeBytes` | 数据目录所在分区可用字节（`statfs`，失败时 0） |
| `uptimeSec` | 进程存活秒数 |
| `version` | 应用版本（原有字段） |

任何一项探测失败都退化成安全默认值——健康检查本身不会因为观测失败变成非 200。

响应示例（`AUTH_TOKEN=tok_TASK7_SECRET` 起的本地实例，数字随数据变化）：

```json
{"ok":true,"version":"1.0.0","provider":"stub","counts":{"messages":220,"todos":39,"pending":39,"done":0},
 "storeBytes":104973,"messages":220,"todos":39,
 "lastExtract":{"durationMs":0,"costUsd":0,"provider":"stub"},
 "liveConnected":false,"diskFreeBytes":243626192896,"uptimeSec":3}
```

**health 不是公开路径**，它和别的 `/api/*` 一样受 `AUTH_TOKEN` 保护。带/不带 token 的差别：

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7789/api/health
401
$ curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:7789/api/health?t=$TOKEN"
200
```

巡检脚本要带 `?t=` 或 `qqtd` Cookie。响应里不含任何 token、密钥、环境变量原文。

## 4. journald 与日志轮转

现状：`journalctl --disk-usage` 在长期运行的机器上会缓慢增长；`/etc/systemd/journald.conf` 默认不做显式限制，
走默认策略（默认上限约为磁盘的 10%，达到后才开始回收）。

### 建议值

`/etc/systemd/journald.conf` 里取消注释并设置：

```ini
[Journal]
SystemMaxUse=200M          # journal 总量上限
SystemMaxFileSize=20M      # 单个归档文件上限
MaxRetentionSec=2week      # 最多留两周
```

改完 `systemctl restart systemd-journald`。

### 临时瘦身

```bash
journalctl --disk-usage          # 先看多大
journalctl --vacuum-size=200M    # 裁到 200M
journalctl --vacuum-time=14d     # 或按时间裁
```

### 只给这个服务限流（建议先做这个，改面最小）

```bash
mkdir -p /etc/systemd/system/qq-todo.service.d
cat >/etc/systemd/system/qq-todo.service.d/ratelimit.conf <<'EOF'
[Service]
LogRateLimitIntervalSec=30s
LogRateLimitBurst=2000
EOF
systemctl daemon-reload && systemctl restart qq-todo
```

本仓库**不修改**系统级 journald 配置，上面的值需要人工确认后手动落地。

## 5. 值班常用命令

```bash
systemctl status qq-todo
journalctl -u qq-todo -f                                 # 跟日志
journalctl -u qq-todo-backup -n 50                       # 昨天备份跑没跑
/opt/qq-todo/deploy/backup.sh                            # 出事前手动补一份
node /opt/qq-todo/deploy/restore-drill.mjs <备份.tar.gz>  # 恢复前先演练
df -h /                                                  # 盘
TOKEN=$(sed -n 's/^AUTH_TOKEN=//p' /opt/qq-todo/.env)
curl -s "http://127.0.0.1:7789/api/health?t=$TOKEN"      # 体检
```
