# 实时接收（只读）接入说明

本目录只做一件事：让 `qq-todo` 作为 **第二个只读 WebSocket 客户端** 连上已有的 NapCat OneBot 11 服务，收群消息落库。
它**不会**发任何 QQ 消息、不调用任何非查询 OneBot API、不改 NapCat / `dsh-qq-bridge` / `dsh-qq-agent` 的任何配置，也不占用 `dsh-qq-bridge` 的 `127.0.0.1:8787`。

## 0. 前置事实（部署机 `<your-server-ip>`）

| 项 | 值 |
|---|---|
| NapCat OneBot 11 WS server | `ws://127.0.0.1:3001/`（token 认证，`messagePostFormat: array`） |
| 已有客户端 | `/opt/dsh-qq-bridge`（继续照常跑，互不影响，**不要重启它**） |
| 本项目 | `/opt/qq-todo`，Node `/usr/local/bin/node`，Web 端口 `7788` |
| 订阅器代码 | `src/live/napcat.js`，仅当 `LIVE_ENABLED=on` 时由 `src/server/index.js` 调用 |

## 1. 在 `.env` 里打开只读订阅

在 `/opt/qq-todo/.env`（systemd `EnvironmentFile`，**文件必须存在**，否则 unit 起不来）追加：

```dotenv
LIVE_ENABLED=on
NAPCAT_WS_URL=ws://127.0.0.1:3001/
NAPCAT_ACCESS_TOKEN=<NapCat 里配置的 access token>
# 可选：只收这些群（逗号分隔，写群名，不是群号）。留空=全收
GROUP_ALLOWLIST=测仪2602班群
```

其它相关默认值：端口 `PORT=7788`、`HOST=0.0.0.0`、`AUTH_TOKEN=<手机访问令牌>`、`DATA_DIR=./data`。

> token 只写进服务器上的 `.env`，权限建议 `chmod 600 /opt/qq-todo/.env`。不要提交到仓库。

## 2. 安装并启动服务

```bash
# 代码放到 /opt/qq-todo（已有则跳过）
cd /opt/qq-todo

sudo cp deploy/qq-todo.service /etc/systemd/system/qq-todo.service
sudo systemctl daemon-reload
sudo systemctl enable --now qq-todo
sudo systemctl status qq-todo --no-pager
```

只新增 `qq-todo.service` 一个 unit；不触碰 `dsh-qq-bridge.service`、`dsh-qq-agent`、NapCat 的服务与配置。

## 3. 验证确实收到了消息

```bash
# 连接建立日志（订阅器打 [live] 前缀）
sudo journalctl -u qq-todo -f | grep --line-buffered '\[live\]'

# 另开一个终端看接口状态
curl -s http://127.0.0.1:7788/api/live
# 期望：{"enabled":true,"connected":true,"groups":["测仪2602班群"],"lastEventAt":"2026-10-30T00:12:00+08:00"}
```

期望的日志序列：

```
[live] 已连接 ws://127.0.0.1:3001/
```

然后在被放行的群里发一条消息，30 秒内应看到 `lastEventAt` 变化、`GET /api/messages` 里出现 `source:"napcat"` 的新消息。
若只看到 `[live] LIVE_ENABLED 未开启，订阅器不连接`，说明 `.env` 里的 `LIVE_ENABLED` 没生效（改完必须 `systemctl restart qq-todo`，systemd 不会热读环境文件）。

## 4. 定时增量拉取（回补历史消息）

实时通道只在进程活着时收消息，重启期间/断线期间的消息要靠轮询回补。源码 `src/live/poller.js`，游标落 `<DATA_DIR>/live-poll.json`。

```dotenv
LIVE_POLL_ENABLED=on
LIVE_POLL_INTERVAL_SEC=300        # 默认 300，最小 30
LIVE_POLL_MAX_PER_GROUP=50        # 单群单次上限，默认 50
```

```bash
cd /opt/qq-todo
node src/live/poller.js --once    # 只跑一轮，日志：处理 N 条、新增 M 条、errors E
node src/live/poller.js           # 常驻（跟随 server 进程时不单独跑）
# 关闭：sed -i 's/^LIVE_POLL_ENABLED=.*/LIVE_POLL_ENABLED=off/' /opt/qq-todo/.env && systemctl restart qq-todo
```

游标语义：每群存一条 `message_seq`（含起点，跳过页首那条），去重靠 `message_id`；NapCat 对空群/不可访问群返回 `retcode 1200`，按软跳过处理、不计 errors。
失败退避：`间隔 × min(2^连续失败, 8)`，恢复后回到基准间隔。

> **为什么用进程内定时链而不是 systemd timer**：退避需要跨轮的失败计数，`setInterval`/`setTimeout` 链天然带着上一轮状态；独立 timer 每次都是新进程，得额外持久化失败次数，还会把日志拆成两条流。

## 5. 到期提醒走 QQ（不用 FCM，也不动旧的 Web Push）

服务器上 `curl https://fcm.googleapis.com/...` 是 `000`（14 秒超时），国产安卓上 Web Push 基本收不到；
QQ 私聊是唯一验证过能到的通道（线上日志：`sent -> 10001: ok {"message_id":...}`）。

新增的是**独立**的三个 unit，旧的 `qq-todo-remind.service`（Web Push 版）一个字都没动：

| 文件 | 作用 |
| --- | --- |
| `deploy/remind.mjs` | 取 `/api/todos?status=pending&limit=200`，分「已逾期 / 今天到期 / 明天到期」三档，每档最多 5 条 |
| `deploy/qq-todo-qq-remind.service` | 一次性任务：`ExecStart=/usr/local/bin/node /opt/qq-todo/remind.mjs` |
| `deploy/qq-todo-qq-remind-morning.timer` | 每天 `08:05` |
| `deploy/qq-todo-qq-remind-evening.timer` | 每天 `20:00` |
| `deploy/install-qq-remind.sh` | 装 unit + 启用 timer + 干跑 |

```bash
bash /opt/qq-todo/deploy/install-qq-remind.sh   # 里面的真发送那行是注释掉的
systemctl list-timers 'qq-todo-qq-remind-*' --no-pager

# 干跑（只打印，不发送、不写数据）
set -a; . /opt/qq-todo/.env; set +a
DRY_RUN=1 /usr/local/bin/node /opt/qq-todo/remind.mjs

# 立刻真发一条
systemctl start qq-todo-qq-remind.service
journalctl -u qq-todo-qq-remind.service -n 20 --no-pager
```

三档全空时只打印 `nothing-due` 并以 0 退出，不会打扰。

- `ExecStart` 写的是 `/opt/qq-todo/remind.mjs`（平铺位置，和旧的 `notify.mjs` 一致）。仓库里脚本在 `deploy/`，`install-qq-remind.sh` 发现平铺位置没有时会自动 `cp deploy/remind.mjs + deploy/notify.mjs` 过去，所以两种布局都能跑。
- node 在 `/usr/local/bin/node`，**不是** `/usr/bin/node`（旧的 `qq-todo-notify.service` 就是踩了这个坑）。
- `remind.mjs` 只读 `/api/todos`，不改任何数据；`API` 地址默认取 `http://127.0.0.1:${PORT}`，服务器上 `PORT=7789`（7788 是 TLS 口）。

## 6. 新待办即时提醒（每 10 分钟扫一次）

`qq-todo-notify.timer` 是每天 08:00、`qq-todo-qq-remind-*.timer` 是 08:05/20:00；
新群消息抽取出待办之后，用户仍要等定时器才知道。这一条补的是「刚抽出来就推」：

| 文件 | 作用 |
| --- | --- |
| `deploy/notify-new.mjs` | 读盘（只读 `store.json`）挑出新待办，拼一条私聊消息发出去 |
| `deploy/qq-todo-notify-new.service` | 一次性任务：`ExecStart=/usr/local/bin/node /opt/qq-todo/notify-new.mjs` |
| `deploy/qq-todo-notify-new.timer` | `OnCalendar=*:0/10`（每小时 0/10/20/30/40/50 分），`Persistent=true` |
| `deploy/install-notify-new.sh` | 装 unit + `enable --now` + `daemon-reload` + 干跑 |

```bash
bash /opt/qq-todo/deploy/install-notify-new.sh
systemctl list-timers qq-todo-notify-new.timer --no-pager

set -a; . /opt/qq-todo/.env; set +a
DRY_RUN=1 /usr/local/bin/node /opt/qq-todo/notify-new.mjs   # 只打印，不写状态
systemctl start qq-todo-notify-new.service                   # 真跑一次
journalctl -u qq-todo-notify-new.service -n 20 --no-pager
```

状态机（状态文件 `<DATA_DIR>/notify-new-state.json`，tmp+rename 原子写）：

- **靠 `createdAt` 游标取新**：没给 `--since` 时用状态里的 `lastNotifiedAt`；服务端将来可以直接传 `--ids t_a,t_b`。
- **第一次运行只记基线**：没有任何游标时只写 `lastNotifiedAt` 并打印 `baseline`，不会把历史待办一次性全推一遍。
- **同一 id 不重推**：已推过的 id 记在 `sentIds`（上限 500，FIFO）。
- **限流**：1 小时最多 3 次；超出的把 id 攒进 `pendingIds`，下一轮和新的一起推（展示仍只列 5 条，多余写「…还有 N 件」）。
- **发送失败**：不动 `sentIds`、把 id 留在 `pendingIds`，下一轮重试同一批。
- 参数：`--ids t_x,t_y` / `--since 2026-11-02T10:00:00+08:00` / `--dry-run`；`DRY_RUN=1` 等价于 `--dry-run`。

## 7. 安全关闭（只停订阅、不影响其它服务）

```bash
# 方式一：只关实时接收，Web 与已入库数据照常可用
sudo sed -i 's/^LIVE_ENABLED=.*/LIVE_ENABLED=off/' /opt/qq-todo/.env
sudo systemctl restart qq-todo
curl -s http://127.0.0.1:7788/api/live     # 期望 enabled:false, connected:false

# 方式二：整个 qq-todo 停掉/禁用
sudo systemctl stop qq-todo
sudo systemctl disable qq-todo
```

关闭后 NapCat 只是少了一个只读客户端，`dsh-qq-bridge` 的行为不受影响。

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `[live] 连接错误` + 反复 `5 秒后重连`，`connected:false` | token 不对或 NapCat 未监听 3001。核对 `NAPCAT_ACCESS_TOKEN`（注意 401 时 Node 内置 WebSocket 会自行重试一次，日志里会看到两条错误） |
| 一直 `connected:true` 但收不到任何消息 | `GROUP_ALLOWLIST` 写错（必须与事件里的 `group_name` 完全一致，不能写群号）；或 NapCat 侧该群未开启上报 |
| 连续失败 20 次后日志变成 60 秒一次 | 正常退避：前 20 次每 5 秒重试，之后每 60 秒一次，不会让进程退出 |
| unit 启动失败 `Failed to load environment files` | `/opt/qq-todo/.env` 不存在，先创建 |
| 端口被占 | `PORT` 冲突，改 `.env` 里的 `PORT` 后重启 |

## 9. 已知风险

- **多客户端**：NapCat 的 WS server 是否允许多个客户端同时连，取决于其服务端实现与版本。本订阅器是第二个客户端；若 NapCat 只允许单客户端，`dsh-qq-bridge` 可能被顶掉——上线前请先在服务器上用 `journalctl -u dsh-qq-bridge` 确认 bridge 仍在线。真顶掉了就 `LIVE_ENABLED=off` 回退，订阅器不会写任何 NapCat 配置。
- **token 轮换**：NapCat 侧改 token 后必须同步 `.env` 并 `systemctl restart qq-todo`，否则会一直 401 重连（每 5 秒→60 秒退避）。
- **群名口径**：白名单与 `groupName` 都取 `event.group_name`；群改名或同名群会导致过滤失效/误收，必要时改用全收后在前端按群筛选。
- **只读边界**：`src/live/**` 只做 WS upgrade、收帧、close，只发查询类动作（`get_status` / `get_image` / `get_group_file_url` / `get_group_list` / `get_group_msg_history`），不发任何消息、不改任何 NapCat 配置。真正会发 QQ 消息的只有 `deploy/notify.mjs` / `deploy/remind.mjs` / `deploy/notify-new.mjs`，且一律 `send_private_msg` 给 `OWNER_QQ`。自查：`grep -rn "send_" src/live/` 应为空。
- **群文件/图片落盘**：附件在 `<DATA_DIR>/attachments/`、图片在 `<DATA_DIR>/images/`，按 8MB 上限、按 fileId 幂等；两个目录都**没有 TTL 清理**，长期会涨，必要时手动 `find <DATA_DIR>/images -mtime +30 -delete`。
- **图片路径落库**：`attachmentFile` 会被 `src/store.js` 的 `normalizeMessage` 保留；`imageFile` 目前不在其白名单里，poller 写进去也会被丢弃（实时通道仍能看到），需要 core-a 补字段。
