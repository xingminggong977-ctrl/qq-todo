# 安全策略

## 报告漏洞

请**不要**在公开 issue 里描述安全问题。

用 GitHub 的私密渠道：[Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库页面 → `Security` → `Report a vulnerability`）。

报告里请包含：

- 受影响的版本 / commit
- 复现步骤（能跑的最小例子）
- 影响面（能不能读到别的数据、能不能越权调 `/api/*`、能不能让服务崩）
- 你希望的披露时间

我们会在 7 天内确认收到，并在修复发布后于 advisory 里公开致谢（除非你要求匿名）。

## 本项目的安全模型（读之前先知道边界）

- **单用户、自托管**。没有多租户、没有注册登录。`AUTH_TOKEN` 是一个共享口令，
  谁拿到它谁就是管理员，因此它必须足够长、随机、且不进版本库。
- **`AUTH_TOKEN` 留空 = 完全不鉴权**。这只在本机开发时合理；把它暴露到公网等于把数据交给所有人。
- 服务会读取你导入的 QQ 聊天记录（其中含他人信息）。**数据默认只存在 `DATA_DIR` 下的 `store.json`**，
  不会上传到任何第三方；但如果你把 `LLM_PROVIDER` 配成远程模型，消息正文会发往你指定的那个端点——
  这属于你自己的选择，请自行评估。
- NapCat / OneBot 的连接是**只读订阅**：本项目只 `get_group_msg_history` / 收事件，
  不主动发消息（提醒功能除外，且需要你显式开启）。
- 反代务必自己加 HTTPS：`AUTH_TOKEN` 走明文 HTTP 会被同网段嗅探。

## 我们视为「漏洞」的东西

- 绕过 `AUTH_TOKEN` 访问 `/api/*` 或页面
- 通过导入文件 / Web Push 订阅 / 附件 URL 读取到 `DATA_DIR` 之外的任意文件（路径穿越）
- 服务端请求伪造（让服务去请求内网地址）
- 存储型 XSS（群名、昵称、消息正文都是不可信输入）
- 备份/恢复流程导致的越权读

## 不在范围内

- 你自己把 `AUTH_TOKEN` 设成空、或写进公开仓库
- 你自己把 `VAPID_PRIVATE_KEY`、`LLM_API_KEY` 提交上去
- 依赖本身的 CVE（请直接报给上游；如果本项目有可利用的调用方式，请报给我们）
- 需要物理接触或已 root 的前提条件
