# QQ 待办台 · 实现契约（唯一事实来源）

本文件由调度者维护。四个执行者的代码必须逐字节符合这里的路径、字段名、取值域；不符合即视为不通过。

## 0. 目标与部署事实

把 QQ 群消息（导入 or 实时）→ LLM 判断「哪几条真的需要我处理」→ 生成带截止日期、约束要点、原文溯源的待办 → 手机浏览器打开勾选。

**部署目标机器**：`your-server`（阿里云 ECS，Ubuntu 22.04，Node v24.22.1，2 vCPU / 4 GiB）。
**开发机器**：Windows，工作目录 `仓库根目录`（Node v24.19.0）。
因此：**代码必须同时能在 Windows 与 Linux 上跑**。路径一律用 `node:path`，不写死分隔符；不调用 Windows 专属 API；文件权限相关代码必须容错（`chmod` 失败不抛错）。

**已有生产环境（禁止改动）**：
- `/opt/dsh-qq-bridge`（`dsh-qq-bridge.service`，监听 `127.0.0.1:8787`，SQLite 队列）
- NapCat：`127.0.0.1:3001`（OneBot 11 WS server，token 认证，`messagePostFormat: array`），QQ 号 `10086`
- `/opt/dsh-qq-agent`（persona / audit / 自动加好友 / 危机监控）
本项目的任何代码、脚本、服务**不得**写这些目录、不得重启这些服务、不得改动它们的配置。实时订阅器只能作为**只读客户端**连接 `ws://127.0.0.1:3001`。

视频参考点（必须还原的交互）：

1. 消息流列表：群名 + 发送者 + 时间 + 类型角标（文件 / 图片 / 回复 / @全员）
2. 待办卡：`待办` 角标 + `10月12日 截止` + 标题 + ≤3 条约束 chip + `来源：某群` + `查看完整原文` + `纠错`
3. 待办台：按紧急度着色的左侧竖条、圆形勾选框、来源群标签、误报项 `不是待办` 按钮、勾完沉到「已完成」
4. 统计：`N → M` 漏斗大字（N 条消息，M 项待办）

## 1. 技术边界（不可协商）

- 纯 ESM `.js`（`scripts/` 下用 `.mjs`）。**不写 TypeScript**、不引框架。
- 依赖：只允许新增 `qrcode`（^1.5.4，仅 B 用）。其余一律 Node 内置（`node:http`/`node:fs`/`node:crypto`/`node:path`/`node:sqlite` 可选）。**禁止** express / better-sqlite3 / openai-sdk / dotenv / chalk / ws（Node 24 自带全局 `WebSocket`）。
- 存储：单个 JSON 文件 `<DATA_DIR>/store.json` + 进程内写队列 + 原子替换（写 `.tmp` → `renameSync`）。所有读写只能经过 `src/store.js`，其它模块禁止直接碰文件。`DATA_DIR` 来自 env，默认 `./data`。
- `.env` 自己解析（≤20 行），不引 dotenv。`.env` 不存在时全部走默认值，不报错。
- 时间一律北京时间，ISO 字符串带 `+08:00`；日期字段 `YYYY-MM-DD`。
- 端口默认 `7788`，`HOST` 默认 `0.0.0.0`。
- 代码注释用中文、短句、只写「为什么」；不写「是什么」的复述注释。

## 2. 目录所有权（越界即返工）

| 执行者 | 可写路径 |
|---|---|
| A（core） | `src/shared/` `src/config.js` `src/store.js` `src/ingest/` `src/extract/` `src/cli/` `fixtures/` |
| B（server） | `src/server/` `scripts/` `package.json` `package-lock.json` `.env.example` `.gitignore` `README.md` |
| C（web） | `public/` |
| D（live） | `src/live/` `deploy/` |
| 调度者 | `SPEC.md` `data/` |

禁止创建上表之外的顶层文件/目录。`data/` 只由运行时写入；样例数据放 `fixtures/`。

## 3. 数据模型（`<DATA_DIR>/store.json`）

```jsonc
{
  "version": 1,
  "messages": [Message],
  "todos": [Todo],
  "runs": [Run],
  "corrections": [{ "id": "c_x", "todoTitle": "…", "messageText": "…", "createdAt": "…" }]
}
```

### Message

```jsonc
{
  "id": "m_1a2b3c4d5e6f",      // "m_" + sha1(groupName|ts|sender|text)[0:12]
  "groupName": "示例放行群",
  "sender": "罗雨",
  "ts": "2026-10-11T12:11:00+08:00",
  "kind": "text",              // text | file | image | reply | at_all | mixed
  "text": "完整正文，保留换行与原始标点",   // 不截断
  "attachment": { "name": "附件6.pdf", "size": null },   // 无则 null
  "source": "qq-export:2026秋-班群.txt",   // 或 "mock" / "napcat"
  "noise": false,              // 明显闲聊/纯表情/「收到」→ true，默认不送模型
  "raw": "原始行文本（多行用 \\n 连接）"
}
```

`kind` 判定优先级（命中即止）：`at_all`（含 `@全体成员`/`@所有人`）> `file`（`【文件】` 或 `.pdf/.docx/.xlsx/.zip/.pptx` 附件行）> `image`（`【图片】`/`[图片]`）> `reply`（`【回复】`/`回复 @`）> `text`；同时命中多类时用 `mixed`。

### Todo

```jsonc
{
  "id": "t_9f8e7d6c5b4a",
  "messageId": "m_1a2b3c4d5e6f",
  "title": "组织填写体测安全风险告知书（附件6）",   // ≤30 字，动宾，去「关于/各位」
  "deadline": "2026-10-12",        // YYYY-MM-DD 或 null
  "deadlineText": "10月12日",       // 原文表述；null 表示原文无截止
  "constraints": ["以班级为单位组织填写", "不漏一人·不能代签", "交至陈倩老师处"],  // ≤3 条，每条 ≤14 字
  "confidence": 0.82,
  "reason": "一句为什么算待办（≤40 字）",
  "status": "pending",             // pending | done | dismissed
  "source": { "groupName": "…", "sender": "…", "ts": "…" },
  "model": "stub",
  "createdAt": "2026-10-29T23:50:00+08:00",
  "updatedAt": "2026-10-29T23:50:00+08:00",
  "doneAt": null,
  "dismissedAt": null
}
```

同一条消息最多产出一条 todo（`messageId` 唯一）。重复抽取不得产生重复 todo。

### 3.1 共享模块（A 提供，B/C/D 直接 import，不得各自复制）

```js
// src/config.js
export function loadEnv(dir = process.cwd())   // 解析 <dir>/.env 写入 process.env（不覆盖已有值），返回 env 快照对象
export const DEFAULTS                          // { PORT:7788, HOST:"0.0.0.0", DATA_DIR:"./data", LLM_PROVIDER:"stub", ... }

// src/shared/message.js
export function makeMessageId(groupName, ts, sender, text) // -> "m_xxxxxxxxxxxx"
export function normalizeKind(text, attachment)            // -> "text"|"file"|"image"|"reply"|"at_all"|"mixed"
export function toBeijingISO(dateOrSeconds)                // -> "2026-10-11T12:11:00+08:00"

// src/shared/time.js
export function todayISO()                     // 北京时间 "YYYY-MM-DD"
export function daysLeft(dateStr)              // 整数，可为负；null 输入返回 null
export function formatRelative(iso)            // "今天 12:11" / "昨天 20:30" / "10-11 12:11"
```

A 必须**优先**交付 `src/config.js` 与 `src/shared/`，交付后立即向调度者回报一次，再继续做 `store.js` / 解析器 / 管道——D 的订阅器要 import `makeMessageId`/`normalizeKind`，B 的启动器要 import `loadEnv`。

### Run

```jsonc
{
  "id": "r_abcd1234",
  "kind": "ingest",              // ingest | extract
  "startedAt": "…", "finishedAt": "…",
  "imported": 220, "skipped": 3, "processed": 0, "todos": 0,
  "errors": 0, "provider": "stub", "costUsd": 0
}
```

`runs` 只保留最近 50 条。

## 4. HTTP API 契约

响应 `Content-Type: application/json; charset=utf-8`。错误统一 `{ "error": { "code": "bad_request", "message": "人话" } }`，状态码 400/401/404/413/500。请求体 JSON 上限 8 MB。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | – | `{ ok:true, version:"1.0.0", provider:"stub", counts:{messages,todos,pending,done} }` |
| GET | `/api/messages?limit=100&group=&noise=exclude` | – | `{ items:[Message], total, groups:[string] }` |
| POST | `/api/ingest` | `{ filename, content, format?:"qq-txt"\|"auto" }` | `{ runId, imported, skipped, groups:[string], warnings:[string] }` |
| POST | `/api/extract` | `{ limit?, force?:false, group? }` | `{ runId, processed, todosCreated, provider, durationMs, costUsd, errors:[string] }` |
| GET | `/api/todos?status=pending&limit=200` | – | `{ items:[Todo], stats:{pending,done,dismissed} }`；`status=all` 为允许的扩展值（返回未过滤全集） |
| GET | `/api/todos/:id` | – | `{ todo:Todo, message:Message\|null }` |
| PATCH | `/api/todos/:id` | `{ status:"done"\|"pending"\|"dismissed" }` | `{ todo:Todo }` |
| GET | `/api/stats` | – | 见下 |
| GET | `/api/live` | – | `{ enabled:boolean, connected:boolean, groups:[string], lastEventAt:string\|null }` |
| POST | `/api/seed` | `{ count?:220 }` | `{ runId, imported }` |
| GET | `/` 及非 `/api` 路径 | – | `public/` 静态；`/`→`index.html`；**无扩展名**的未知路径回落 `index.html`，**带扩展名**的未知路径（如 `/missing.css`）返回 404（见修订 R2） |

`GET /api/stats`：

```jsonc
{
  "counts": { "messages":220, "noise":30, "todos":47, "pending":41, "done":5, "dismissed":1 },
  "funnel": { "messagesProcessed":273, "todosKept":47 },
  "provider": "stub",
  "lastExtract": Run|null,
  "byGroup": [{ "groupName":"示例放行群", "messages":60, "todos":12 }],
  "dueSoon": [{ "id":"t_x", "title":"…", "deadline":"2026-11-21", "daysLeft":3 }]
}
```

`funnel.messagesProcessed` = 已送模型判定的消息条数；`todosKept` = 其中产出 todo 的条数。

### 访问控制

- `AUTH_TOKEN`（env，可空）。为空时不校验（本地开发）。
- 非空时：请求带查询参数 `?t=<token>` 或 Cookie `qqtd=<token>` 任一匹配即通过；通过后用 `Set-Cookie: qqtd=<token>; Path=/; Max-Age=2592000; SameSite=Lax` 记住 30 天。
- 不通过 → 401 `{ error:{code:"unauthorized", message:"需要访问令牌，请用带 ?t= 的链接打开"} }`。
- 校验覆盖 `/api/*` 与静态资源；二维码链接必须带 `?t=`。

## 5. LLM Provider 契约（`src/extract/provider.js`）

```js
export async function createProvider(env) // -> Provider
// Provider = { name: string, classify(messages: Message[], signal?) => Promise<ClassifyResult[]> }
// ClassifyResult = { messageId, isActionable, title, deadline, deadlineText, constraints, confidence, reason }
```

- `LLM_PROVIDER=stub`：纯本地规则（关键词 + 日期正则 + 闲聊黑名单），**不得联网**，结果确定可复现。用于无 key 时跑通全链路与验收。
- `LLM_PROVIDER=openai`：`POST ${LLM_BASE_URL}/chat/completions`，`response_format:{type:"json_object"}`，`temperature:0.1`。429/5xx/超时指数退避重试 3 次，仍失败则该批计入 `errors`，不得让整次抽取崩掉。单请求超时 90s。
- 判定规则（prompt 与 stub 必须一致）：
  - 只把「需要我本人或我所在班级/组织执行具体动作」算待办
  - 排除：纯闲聊、约饭约玩、纯表情、图片无正文、「收到/好的」、已结束的活动、纯通报且无需动作
  - `deadline` 换算 `YYYY-MM-DD`；原文无年份时按消息时间推断（不得早于消息日期，不得晚于消息日期 +1 年）：「10月12日24点」→ 该日
  - `constraints` ≤3 条、每条 ≤14 字，抽「谁来做/怎么做/交给谁」的硬约束
  - 不确定 → `isActionable=false` 且 `confidence<0.5`（宁缺勿滥）
- 成本：累加 `usage.prompt_tokens/completion_tokens`，单价 env `LLM_PRICE_IN`/`LLM_PRICE_OUT`（默认 0.14/0.28 美元/百万 token），写进 `Run.costUsd`。

## 6. 前端契约（`public/`）

- 纯静态、无框架、无 CDN、无构建：`index.html` `app.js` `styles.css` `manifest.webmanifest` `sw.js` `icon.svg`（外加 `icon-192.png`/`icon-512.png` 可纯色占位）。
- 视觉：底 `#0b0b0f`、卡片 `#14141b`、分隔 `#232330`、主文字 `#e8e8f0`、次要 `#8b8b9e`、紫 `#7c5cff`、琥珀 `#f0a93b`、红 `#e5484d`。
- 顶部 tab：`消息流` / `待办台` / `统计`。
- 待办台：按 `deadline` 升序（无截止排最后）；左 3px 竖条：逾期红、≤3 天琥珀、≤14 天紫、其余 `#3a3a4a`。点圆圈 → `PATCH {status:"done"}`；`不是待办` → `PATCH {status:"dismissed"}`；`查看完整原文` 开右侧抽屉（≤640px 时全屏），内容取 `GET /api/todos/:id`。
- 已完成区标题 `已完成 | 勾选的事项`，置灰 + 紫色对勾，可点回 `pending`。
- 消息流：群名 + 发送者 + 相对时间（`今天 12:11`）+ 类型角标 + 正文两行截断。顶部两个动作：`导入聊天记录`（选本地 txt → 读文本 → `POST /api/ingest`，body `{filename, content}`）与 `开始判断`（`POST /api/extract`，请求中按钮显示 `理解中…` 并禁用）。若 `GET /api/live` 的 `connected` 为 true，显示一个绿色小点 + `实时接收中`。
- 统计：居中大字 `N → M`——左数取 `counts.messages`（收到的消息总条数），右数取 `counts.todos`（留下来的待办数）；下面小字「条消息，最后真正留下来需要处理的」；再补 `待办/已完成/已排除` 三个数字与按群分布，并把 `funnel.messagesProcessed`（去噪后真正送去判定的条数）作为副标注写出来，说明「N 条里有多少条只是闲聊」。
- 响应式：≤640px 单列，tab 固定顶部，触控目标 ≥40px。PWA：`display:"standalone"`、`theme_color:"#0b0b0f"`、`sw.js` 只缓存静态外壳，**不缓存 `/api/`**。
- 空态要友好：无消息时提示「先导入 QQ 导出的聊天记录」并给按钮，不白屏。
- 无数据/加载失败要有可见提示，禁止静默失败。

## 7. 启动行为（`src/server/index.js`）

1. 读 `.env` → 建 store → 启动 HTTP → 若 `LIVE_ENABLED=on` 则启动实时订阅器
2. 监听 `HOST:PORT`
3. 打印（有 `PUBLIC_URL` 时用它，否则用局域网 IP）：
   ```
   本机： http://127.0.0.1:7788
   手机： http://<PUBLIC_URL 或局域网IP>:7788/?t=<AUTH_TOKEN>
   ```
   并把「手机」那条打成终端二维码（`qrcode`）。文本太长打不出二维码时只打地址，不报错。
4. 取不到非回环 IPv4 时只打本机地址并给一行提示
5. `SIGINT`/`SIGTERM` 干净退出（关订阅器、清写队列）

## 8. 实时订阅器契约（`src/live/`）

```js
// src/live/napcat.js
export function startLive({ env, onMessage })  // -> { ready:Promise<void>, status(), stop() }
// startLive 只在 LIVE_ENABLED=on 时被 server 调用
```

- 用全局 `WebSocket` 连 `NAPCAT_WS_URL`（默认 `ws://127.0.0.1:3001/`），连接头带 `Authorization: Bearer ${NAPCAT_ACCESS_TOKEN}`。
- 只处理 `post_type==="message"` 且 `message_type==="group"` 的事件；其它忽略。
- OneBot 11 `message` 为 segment 数组时拼文本：`text` 取 `data.text`；`at` 且 `data.qq==="all"` → 前置 `@全体成员`；`image` → `【图片】`；`file` → `【文件】${data.file||data.name||""}`；其它类型记 `[${type}]`。
- 归一化成 Message（`kind` 规则同 §3，`source:"napcat"`，`ts` 由 `time`（秒）转北京时间），按 `id` 去重后交给 `onMessage`。
- 断线 5 秒后重连，最多连续 20 次，之后每 60 秒试一次；重连过程不得抛未捕获异常。
- `GROUP_ALLOWLIST`（env，逗号分隔群名）非空时只收白名单内的群。
- 不发送任何 QQ 消息、不调用任何非查询类 OneBot API——只读。

`deploy/qq-todo.service`：systemd unit，`Type=simple`，`WorkingDirectory=/opt/qq-todo`，`EnvironmentFile=/opt/qq-todo/.env`，`Restart=always`，`User=root`，不覆盖任何已有用户/服务。

## 9. 验收（调度者执行，不达标即返工）

```powershell
npm.cmd install
npm.cmd run smoke     # exit 0，打印 PASS 行
npm.cmd start         # 打印本机/手机地址与二维码
```

`scripts/smoke.mjs` 必须（全部用临时 `DATA_DIR`，不污染 `data/`）：

1. `POST /api/seed {count:220}` → `imported >= 200`
2. `POST /api/extract` → `20 <= todosCreated <= 120` 且 `processed >= 150`
3. `GET /api/todos` 至少 1 条有 `deadline`，至少 1 条 `constraints.length >= 2`
4. `PATCH /api/todos/:id {status:"done"}` → 返回 `status:"done"`；随后 `GET /api/stats` 的 `counts.done >= 1`
5. `GET /api/stats`：`funnel.messagesProcessed >= 150` 且 `funnel.todosKept >= 20`
6. 再次 `POST /api/extract` 后 `counts.todos` 不增加（幂等）
7. 随机取 1 条 mock 消息：`text.length >= 10`，且 `raw` 包含 `text` 的前 10 个字符
8. `GET /api/health` 200 且 `ok === true`
9. 断言失败时打印「期望 vs 实际」，退出码非 0

调度者人工验收：手机扫码可开；待办台截图与视频构图一致；填真 key 后真实抽取跑通；`data/` 放入真实导出文件后 CLI 导入能解析并报告未识别行；公网 `http://your-server:7788` 在安全组放行后可打开。

## 10. 明确不做（v1）

- 不做登录/多用户/权限体系（只有一个 `AUTH_TOKEN`）
- 不做推送通知（QQ/微信/邮件）
- 不做「不是待办」自动改模型（只记录 `corrections`）
- 不做增量同步（按 `message.id` 去重即可）
- 不改动 `/opt/dsh-qq-bridge`、`/opt/dsh-qq-agent`、NapCat 配置
