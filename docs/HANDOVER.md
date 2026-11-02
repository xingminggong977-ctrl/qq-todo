# 上线与验收说明

这份文档记录本项目的**上线形态**与**验收口径**，是从一次真实私有部署整理出来的通用版本：
换成你自己的机器、域名、口令即可照做。

```
https://your-host.example.com/?t=<你的 AUTH_TOKEN>
```

二维码由服务启动时打印（`journalctl -u qq-todo` 里那条），手机扫一次后 30 天内免口令（服务端种 Cookie），之后直接开域名即可。

---

## 一、一种无需公网入站的部署方式：出站隧道

如果机器的安全组没放行 7788 端口，可以不改安全组，改用一条**出站反向隧道**：
服务器上跑 `cloudflared`（systemd 服务 `qq-todo-tunnel`），由服务器主动连到 Cloudflare 边缘，
公网通过 `https://<随机域名>.trycloudflare.com` 反向打到本机 `127.0.0.1:7788`。

- 不用动安全组、不用弹性 IP 放行、**而且自带 HTTPS**（PWA / Service Worker 因此能正常注册）；
- 代价：`trycloudflare.com` 的域名是临时的。**只有隧道进程重启才会换域名**（正常跑着不会变）。
  万一哪天打不开，服务器上一条命令拿新地址：
  ```bash
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /var/log/cloudflared.log | head -1
  ```
- 想要一把永不变化的地址：放行安全组 7788 → `http://your-server:7788/?t=<同一个口令>`，两条路可以并存。

---

## 二、判定引擎现在是「规则 + 离线」

`LLM_PROVIDER=stub`：本地规则引擎判定（命中「【通知】/截止/需/请各班…」这类线索 + 时间解析 + 约束抽取），
**离线、零成本、不依赖任何 key**，演示数据就是它跑出来的 273 → 47。

想换成你自己的大模型（可选，不做也能用）：
```bash
ssh root@your-server
vi /opt/qq-todo/.env        # LLM_PROVIDER=openai / LLM_BASE_URL=https://api.deepseek.com/v1 / LLM_MODEL=deepseek-chat / LLM_API_KEY=sk-xxx
systemctl restart qq-todo
```
或者把 `base_url + model + key` 发我，我改完你继续扫码用。

---

## 三、真实 QQ 记录怎么进来

1. QQ 客户端导出群聊天记录为 `.txt`；
2. 手机扫码打开 → **消息流** → **「导入聊天记录」** → 选文件（浏览器本地读取上传，文件不用放到服务器）；
3. 点 **「开始判断」**，待办台自动刷新。

命令行等价（服务器上）：
```bash
cd /opt/qq-todo && node src/cli/import.js --file /path/xxx.txt && node src/cli/extract.js
```

---

## 四、验收证据（都是真实请求，不是自称）

| 证据 | 结论 |
|---|---|
| `.artifacts\final\verify.json` | 打线上实例（SSH 隧道）**24 项断言全 PASS** |
| `.artifacts\final\verify-public.json` | 打**公网 Cloudflare 域名** 8 项全 PASS（401 拦截、273/47、手机 47 行、Cookie 免口令、0 console error） |
| 截图 | `.artifacts\final\01-…07-*.png`（隧道侧 + 手机三屏）、`public-*.png`（公网侧） |
| 代码回归 | `npm run smoke` 14 PASS / exit 0；`fixtures/selftests/*` 四支 exit 0；合并单测 20 断言 PASS |

具体数字：大字 `273 → 47`、副标注「其中 36 条是闲聊，真正送去判定的 237 条」、47 行待办、
截止角标全部 `M月D日 截止`（无「点/前」）、四档 `overdue 1 / soon 2 / upcoming 6 / later 38`、
左侧竖条 3px 带色、抽屉原文 78/78 不截断、勾选 → `done 1 / pending 46`、「不是待办」→ `dismissed 1 / pending 45`、
手机 390×844 无横向溢出。

---

## 五、运维速查

```bash
systemctl status qq-todo qq-todo-tunnel      # 两个服务：应用 + 公网隧道
systemctl restart qq-todo                    # 改 .env 后重启
journalctl -u qq-todo -n 100 -f              # 应用日志（启动会打印本机/手机地址 + 终端二维码）
tail -20 /var/log/cloudflared.log            # 隧道日志（换域名时看这里）
cat /opt/qq-todo/.env                        # AUTH_TOKEN / PORT / DATA_DIR / LLM_* / LIVE_*
ls /opt/qq-todo/data && cp /opt/qq-todo/data/store.json /root/store-$(date +%F).json
ls /root/qq-todo-backup/                     # 每次部署前的代码快照
```

- 数据目录 `/opt/qq-todo/data`（就 `store.json` 一个文件）；
- 口令在 `/opt/qq-todo/.env` 的 `AUTH_TOKEN`（`?t=` 传参或 Cookie；两者都没有 → 401，不白屏）；
- 换口令：改 `.env` → `systemctl restart qq-todo` → 重新生成 `QR.png`。

---

## 六、已知边界（这版没做，不是 bug）

1. 只解析 QQ **文本**导出 `.txt`；HTML/MHT 导出不认，`[图片]` 之类富文本段按噪声处理。
2. 消息流只渲染**前 100 条**（页面有提示），无分页。
3. **实时通道默认关闭**（`LIVE_ENABLED=off`）。NapCat 只读订阅器已写好、5 项单测通过，但机器上 NapCat 的 OneBot11 现在只留了一个 WS 客户端位给 `dsh-bridge`（在服务 QQ 10001），再挂一个客户端可能把你的现有机器人挤掉。要开见 `deploy\README.md`，务必先找空闲窗口试。
4. 待办一次性全渲染（47 条 DOM 无压力，上千条需要虚拟滚动）。
5. `sw.js` network-first（避免改版被缓存遮住），离线回落缓存，`/api/` 不缓存。
6. 隧道域名是临时的（见第一节）。

---

## 七、文件地图（本机）

| 路径 | 说明 |
|---|---|
| `QR.png` | 手机扫码图（公网 URL + 口令） |
| `SPEC.md` | 契约文档（接口 / 数据模型 / 验收口径） |
| `src\` | 服务端：`store.js` 存储与同群同标题合并、`ingest/parser.js` QQ 导出解析、`extract/pipeline.js` 抽取、`server/*` HTTP 层、`live/napcat.js` 实时订阅 |
| `public\` | 纯 vanilla 前端三视图（消息流 / 待办台 / 统计）+ PWA |
| `deploy\` | `qq-todo.service` unit、`README-live.md` 实时模式说明 |
| `fixtures\selftests\` | 四支自测（截止日 / 约束 / 解析 / 条数） |
| `.artifacts\final\` | 两端验收脚本 + `verify*.json` + 截图 + 二维码 |
| `.artifacts\*.sh` | 我用的部署 / 隧道脚本（重装服务器时可复用） |

---

## 自动化（2026-11-01 第二次上线）

### 1. 群消息自动回流
NapCat 上那四个群每 **300 秒** 自动补一次历史，游标落在 `data/live-poll.json`，重启不丢。
只拉「上次之后」的消息，按 messageId 去重。开关：`LIVE_POLL_ENABLED`。

### 2. 有新消息就自动判定
`LIVE_POLL_EXTRACT=on` 时，只要这一轮**真的插入了新消息**（`inserted > 0`），就顺手跑一次提取，不需要再点「开始判断」。
- 提取按「未处理消息」取数，即使某轮被跳过，下一轮会把积压补齐；
- 上一次提取没跑完时本轮跳过（日志 `上一次自动提取还在跑`），不会叠跑两份。

### 3. 覆盖口径：三分，不是二分
模型返回的东西分三类，只有第一类才算问题：
| 情况 | 处理 | 计入 |
|---|---|---|
| 调用失败 / JSON 解析不出来 / `finish_reason=length` 被截断 | 重试一次 → 对半拆批 → 单条兜底 | `droppedCount` |
| 解析成功、但某条消息没有 item（模型认为不是待办） | 直接接受 | `implicitNegatives` |
| 模型给了不属于本批的 messageId | 记错误并丢弃 | `errors` |

线上实测：同一批 239 条，改口径前 `modelCalls=60`（打满上限、丢 135 条），改口径后 `modelCalls=11`、`droppedCount=0`、`implicitNegatives=6`、成本 $0.0092。

### 4. 统计口径
`/api/stats` 新增 `totalDropped`（累计丢弃，持久化计数器，不随 runs 截断缩水）与 `lastDropped`（最近一次**提取**的丢弃数）。
`/api/extract` 响应新增 `droppedCount` / `droppedMessageIds` / `implicitNegatives` / `coveredCount` / `modelCalls` / `maxCalls`。

### 5. 每日备份
`qq-todo-backup.timer`，每天 **03:20** 打一份 `data/` 到 `/var/backups/qq-todo/YYYYMMDD.tar.gz`，保留最近 14 份。
备份会当场做一次**恢复演练**（真解包 + 临时实例 + counts 对账），失败会 exit 1 并写日志。
手动：`systemctl start qq-todo-backup.service`，恢复步骤见 `deploy/RESTORE.md`。

---

## 附件正文解析（2026-11-01 第四次上线）

群文件消息以前只拿到文件名，PDF/Word 里的「10月12日前交到陈倩老师处」这类正文会被整体漏掉。现在会下载附件、抽出文本，拼在消息原文之后一起送模型判定。

### 链路
1. **下载**（`src/live/attach-fetch.js`）：收到 `kind:"file"` 且带 `file_id` 的消息，走 OneBot11 `get_group_file_url`（私聊走 `get_private_file_url`）拿临时 URL，落盘 `<DATA_DIR>/attachments/<sha1(fileId)[:16]><后缀>`。幂等（同 fileId 只下一次）、8MB 上限、15s 动作超时；失败只记 `[attach] skip <name>: <原因>`，消息照常入库。
2. **落库**（`src/store.js`）：消息新增 `attachmentFile` 字段（非空字符串且 ≤512 字，否则 null），读回来老数据是 null 而不是 undefined。
3. **解析**（`src/extract/attachments.js`）：`.pdf`→pdf-parse、`.docx`→mammoth、`.txt/.md/.csv/.log`→直接读；单文件 8MB、正文截 4000 字、单次解析 8s 超时、后缀白名单、全程 try/catch 不抛。
4. **拼装**（`src/extract/pipeline.js`）：送模型的副本是 `原文 + "\n\n【附件正文】\n" + 抽出的文本`（最多 3000 字），**库里的 text 保持原样**；同一次 run 内同路径只解析一次。

### 配额与已知边界
- 轮询每轮最多下 **5 个**附件、预算 **30 秒**；实时通道每个文件最多等 10 秒。
- 超出配额或超时的文件**本轮不下载也不会补**（游标已前进，store 没有按 id 补丁的接口）。突发传 6+ 个文件时，消息不丢，只是那几个附件没进判定。
- `DATA_DIR/attachments/` 只增不减，暂无 TTL 清理。

### 验收（服务器上实跑）
- OneBot11 支持性探针：`get_group_root_files` 返回 2 个 pptx → `get_group_file_url` 返回真实下载 URL；错误 file_id 返回 `retcode 1200 real fileUUID not found!`（软失败路径已验证）。
- 端到端（真 store + 真 PDF + stub 判定）：`processed 2 · todosCreated 1`，抓到 `见群文件《体测安全风险告知书》`，`deadline 2026-10-12`（这个日期**只存在于 PDF 正文里**），`confidence 0.87`；库里 `text` 仍是原文。
- 单测：`fixtures/selftests/attach-download.mjs` 39 PASS、`attachments.mjs` 30 PASS、`attachments-pipeline.mjs` 18 PASS、`attachments-store.mjs` 20 PASS；live 回归 test-1..9 合计 126 PASS。

---

## 域名被备案策略拦截 → 换入口（2026-11-02 第五次上线）

### 现象与定性
把服务挪到标准 80/443 后，`http://todo.example.com/` 返回 **403**（未备案拦截页），`https://todo.example.com/` 与 `:7788` 的 TLS 握手直接被重置（curl 报 000）。同一台机器 loopback 访问一直正常（401/200），**拦截在云厂商边缘，不是应用故障**。此前手机端"老是连不上"的主因就是这个。

### 现在的入口
`https://1-2-3-4.sslip.io/?t=<AUTH_TOKEN>` —— Let's Encrypt 真证书（有效期到 2027-01-30，自动续期）、标准 443、PWA 可安装（CDP `Page.getInstallabilityErrors` 返回空数组）。

### 双栈与双证书
- `src/server/index.js`：HTTPS 主服务（`HTTPS_PORT`）+ 仅本机的明文 HTTP（`PORT`，给 notify/remind 脚本用）+ `REDIRECT_PORT` 的 301 跳转层。
- 按 **SNI 的证书 SAN** 选证书：`certHosts(pem)` 解析 `X509Certificate.subjectAltName`，`matchHost()` 支持通配。**不能按 `PUBLIC_URL` 选**——早期这么写，把 `PUBLIC_URL` 改成 sslip 后所有 SNI 都拿到 主域名证书，TLS 直接坏掉。
- `.env` 关键项：`HTTPS_PORT=443`、`PORT=7789`、`HOST=127.0.0.1`、`REDIRECT_PORT=80`、`ACME_WEBROOT=/var/www/acme`、`PUBLIC_URL=https://1-2-3-4.sslip.io`、`TLS_CERT/TLS_KEY`（主域名）、`TLS_ALT_CERT/TLS_ALT_KEY`（sslip）。
- **`src/config.js` 的 `snapshot()` 只返回 DEFAULTS 白名单里的键**：新增环境变量（`ACME_WEBROOT`/`TLS_ALT_*`）不加进 DEFAULTS 就读不到，这个坑踩过两次。

### 证书
- `/root/qq-todo-cert/{fullchain,privkey}.pem`：acme.sh `dns_ali`（CN=todo.example.com）。
- `/root/qq-todo-cert-sslip/{fullchain,privkey}.pem`：LE `http-01`（`serveAcmeChallenge()` 从 `ACME_WEBROOT/.well-known/acme-challenge/<token>` 读文件，路径白名单 `^[A-Za-z0-9._-]{1,128}$`）。
- 事故记录：`acme.sh --install-cert` 在签发失败时会把 `fullchain.pem` 写成 0 字节，HTTPS 当场挂掉。恢复脚本 `.artifacts/final/restore-cert.sh` 从 `/root/.acme.sh/todo.example.com/` 拷回。

### 同批上线
- **弱网自动重试**（`public/app.js`）：GET 失败自动重试 3 次（300/900ms 退避），首屏骨架不闪，断网显示「等待网络」，`online` 事件立刻补一轮。
- **判定门槛收紧**（`src/extract/provider.js` 的 `todo-prompt-v3`）：新增硬门槛 a 明确执行者且非说话人 / b 可检查的交付物或到场动作 / c 下达语气，缺一即否且 confidence ≤ 0.5。
- **提醒去重**：停掉 `qq-todo-remind-morning/evening.timer`（Web Push 那套），只留 `qq-todo-qq-remind-*`，避免同一天两条提醒。
- **备份自查改口**：`deploy/install-backup.sh` 的健康检查从 `https://127.0.0.1:7788`（依赖 socat 透传）改成 `http://127.0.0.1:7789`。


