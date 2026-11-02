# 更新日志

面向使用者的变化记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## v1.0.0 — 2026-11-02

首个公开版本。此前它是一个只给一个人用的私有部署；这一版把「能跑起来的东西」整理成「别人也能跑起来的东西」：补齐安装与配置文档、把示例数据全部换成明显虚构的值、把原先散落在一次性运维脚本里的步骤改写成仓库内的可复用脚本。

### 新增

- **两种输入通道**：导入 QQ 导出的 `.txt` 聊天记录（`src/ingest/parser.js`，页面导入、CLI、`POST /api/ingest` 三个入口），或通过 NapCat（OneBot 11）**只读**订阅实时群消息（`src/live/napcat.js`）。服务端不注册任何发消息类动作。
- **兜底轮询**：实时连接不可用时按间隔增量拉 `get_group_msg_history`，只用查询类 API（`src/live/poller.js` 头注释）。
- **判定三分口径**：每条消息落 `todo` / `noise` / `error` 三档之一，并写入决策日志——上游失败也记一条，保证「每轮完整返回、不缺条目」（`src/extract/pipeline.js` 决策日志构造处）。
- **截止日期与约束抽取**：待办带 `deadline` 与 `constraints`，每条都能溯源到原消息。
- **附件正文解析**：群文件 PDF / DOCX / TXT 抓下来抽正文（`src/extract/attachments.js`：PDF 走 `pdf-parse`、DOCX 走 `mammoth`）。
- **图片正文识别**：可选多模态端点读图，把「作业要求截图」里的文字读成待办依据（`src/extract/vision.js`：模型选择与 `image_url` 组装）。
- **到期提醒**：QQ 私聊提醒（`deploy/remind.mjs`）与 Web Push（`src/server/push.js`，VAPID 密钥自备）。
- **PWA**：`public/manifest.webmanifest` + `public/sw.js`，可加进主屏、断网也能打开外壳。
- **ICS 日历订阅**：`GET /api/calendar.ics` 输出标准 iCalendar（`src/server/api.js` 的路由表）。
- **只读在线演示**：`/demo` 前缀下另起一套只读实例，数据独立在 `<DATA_DIR>/demo`、用离线 `stub` 引擎生成，匿名可打开且绝不写你的真实库（`src/server/demo.js`、`src/server/app.js` 的 `/demo` 分支）。
- **备份与恢复演练**：`deploy/backup.sh` 负责打包，`deploy/restore-drill.mjs` 真解包、真起实例、真对账。
- **自测与门禁**：`npm test` 跑 `fixtures/selftests/*.mjs` 与 `src/live/_test/*.mjs` 全部用例（`scripts/test.mjs`）；`npm run check-secrets` 扫描仓库有没有混入真实标识（`scripts/check-secrets.mjs`）；`.github/workflows/ci.yml` 在 Node 24 上跑完整流程。

### 变更

- **HTTPS 与端口重定向**：新增 `HTTPS_PORT`（`src/config.js` 的 `DEFAULTS.HTTPS_PORT`）与 `REDIRECT_PORT`（`src/config.js` 的 `DEFAULTS.REDIRECT_PORT`），可以让 80 口自动跳到 https（`src/server/index.js` 的 80 口跳转启动段）。
- **附件下载地址现取**：统一走 `get_group_file_url` / `get_private_file_url`，不再依赖会过期的链接（`src/live/attach-fetch.js` 的 `ACTION_BY_KIND`）。
- **私聊通道收紧**：只接受 `OWNER_QQ` 本人的私聊转发，`OWNER_QQ` 为空时私聊整体关闭（`src/live/napcat.js` 的 `ownerQq` 判定）。
- **显示名可覆盖**：`PRIVATE_ALIAS` 改私聊消息在待办台里的分组名，默认「我转发的通知」。
- **仓库公开化**：示例数据、测试夹具、文档里的真实域名/主机/账号全部换成明显的占位值；交付与设计文档归到 `docs/`，运维脚本只留可复用部分。

### 修复

- `REDIRECT_PORT` / `VISION_*` / `VAPID_*` 曾漏在配置白名单之外，导致配置快照读不到这些键——现在一律走 `DEFAULTS`（`src/config.js` 的 `DEFAULTS`）。
- 决策日志在上游模型失败时会缺条目，现在按 `error` 记一条，统计口径不会少算（`src/extract/pipeline.js` 的决策日志构造处）。
- 老 `store.json` 缺 `duplicates` / `snoozedUntil` / 决策日志 / 群设置时，读盘自动补齐，避免下游到处判 `undefined`（`src/store.js` 的读盘补齐逻辑）。
