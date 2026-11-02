# 贡献指南

欢迎 issue 和 PR。这个项目刻意保持「零构建、零框架、少依赖」，所以对引入新东西会比对改逻辑严格得多。

## 环境

- **Node.js >= 24**（用到内置的全局 `WebSocket`、`node:test` 等，22 跑不起来）
- 不需要打包器、不需要 TypeScript、不需要数据库

```bash
git clone <你的 fork>
cd qq-todo
npm install --omit=dev
cp .env.example .env      # 全部有默认值，改成自己的再启动
```

## 跑起来

```bash
npm run seed     # 造一批演示消息（可选，不跑就自己导入 QQ 导出文件）
npm start        # 终端会打印「本机」「手机」两个地址 + 二维码
```

三种判定模式，按需切换 `.env` 里的 `LLM_PROVIDER`：

| 值 | 含义 |
| --- | --- |
| `stub` | 纯本地规则引擎，**不联网、零成本、结果可复现**，CI 与自测用的就是它 |
| `openai` | 任何 OpenAI 兼容的 `/chat/completions` 端点（`LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL`） |

实时订阅（可选）另需 NapCat + `LIVE_ENABLED=on`，见 `deploy/README.md`。

## 测试

提交前请把下面两条跑绿：

```bash
npm test               # 全量自测：fixtures/selftests/*.mjs + src/live/_test/test-*.mjs
npm run smoke          # 起真实服务进程做端到端断言
node scripts/check-secrets.mjs   # 泄漏门禁：真实域名/IP/令牌/QQ 号/本机路径一律 fail
```

`npm test` 的判定口径：每个测试文件单独起进程，**退出码非 0、输出里出现 `FAIL`、或一条 `PASS` 都没打**，都算不通过。

单个文件也可以直接跑，调试更快：

```bash
node fixtures/selftests/parser.mjs
node src/live/_test/test-5-allowlist.mjs
```

### 写新测试的约定

- 放 `fixtures/selftests/<主题>.mjs`，或 `src/live/_test/test-<n>-<主题>.mjs`
- 每条断言 `console.log("PASS"|"FAIL" + 标签 + 期望/实际)`，**失败时把「期望 vs 实际」一起打出来**
- 自己建临时 `DATA_DIR`（`mkdtemp`）并在 `finally` 里删掉，**不要碰仓库里的 `data/`**
- 不联网、不依赖执行顺序、不依赖时区（时间一律北京时间，ISO 带 `+08:00`）

## PR 要求

1. **能跑绿**：`npm test`、`npm run smoke`、`npm run check-secrets` 三条都通过。
2. **不引新运行时依赖**。当前只有 `mammoth`、`pdf-parse`、`qrcode`、`web-push`；
   想加先开 issue 说明为什么内置模块做不到。
3. **不改业务口径**：判定三分（待办 / 不是待办 / 无法判定）、截止日解析、同群同标题合并这些行为
   都有测试盯着，改行为请连同测试与文档一起改，并在 PR 描述里写清「为什么」。
4. **不提交**：`.env`、`data/`、任何真实群名 / 群号 / 域名 / IP / 令牌 / 本机路径。
   `scripts/check-secrets.mjs` 会在 CI 里拦你。
5. **中文注释，只写「为什么」**，不复述「是什么」。
6. 一个 PR 做一件事。格式化的大改动单独开 PR。
7. 提交信息用祈使句（`修掉：...` / `加上：...`），正文说清动机。

## 报告问题的好姿势

- 判定错了：贴**原文**（脱敏后）+ 期望的截止日/标题 + 实际输出
- 服务起不来：贴 `npm start` 的完整输出 + `node --version`
- 实时订阅连不上：贴 NapCat 的 WS 地址（脱敏）+ `journalctl -u qq-todo -n 50`

## 许可证

提交 PR 即表示你同意以 [MIT](LICENSE) 授权你的贡献。
