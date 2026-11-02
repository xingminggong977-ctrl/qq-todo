# 发布清单：把仓库推到 GitHub

这份清单假设你已经在本地跑通 `npm test` 与 `npm run smoke`，且 `node scripts/check-secrets.mjs` 是 0 命中。命令里的 `xingminggong977-ctrl/qq-todo` 换成你自己的账号与仓库名。

## 0. 推之前自查

```bash
node scripts/check-secrets.mjs      # 必须 0 命中
npm test                            # 必须 FAIL 0
npm run smoke                       # 必须退出码 0
git status --porcelain              # 必须为空（没有未提交的草稿）
git ls-files | head -50             # 扫一眼：确认 .env / data/ / node_modules 不在列表里
```

再确认三件容易漏的事：

- `package.json` 的 `repository` / `bugs` / `homepage` 还是占位 `xingminggong977-ctrl/qq-todo`，替换成真实地址。
- README 顶部的徽章 URL 与 `.github/ISSUE_TEMPLATE/config.yml` 里的链接同样是占位 `xingminggong977-ctrl/qq-todo`。
- `git log --format='%an <%ae>' | sort -u` 里没有你不想公开的邮箱（本仓库默认用 `QQ-Todo contributors <contributors@users.noreply.github.com>`）。

## 1. 建仓库并推上去

先在 GitHub 上建一个**空**仓库（不要勾 README / .gitignore / LICENSE，本地已经有了），然后：

```bash
git remote add origin git@github.com:xingminggong977-ctrl/qq-todo.git
git branch -M main
git push -u origin main
```

用 HTTPS 的话把地址换成 `https://github.com/xingminggong977-ctrl/qq-todo.git`。

推完立刻去 Actions 页面看第一次 CI 有没有跑起来。`.github/workflows/ci.yml` 会依次执行：`npm ci --omit=dev || npm install --omit=dev` → 泄漏门禁 → `npm test` → `npm run smoke`。**CI 红了不要打 tag**，先把红的原因修掉。

## 2. 仓库门面自查

打开仓库首页，逐条对照：

- [ ] 描述（About → Description）已填写，一句话说清「QQ 群消息 → 待办清单，自托管」
- [ ] 语言被识别为 JavaScript，不是被 `public/` 里的 HTML 带跑偏
- [ ] LICENSE 显示 MIT，首页右上角能看到
- [ ] README 顶部徽章三个都能加载（CI 徽章在第一次 Actions 跑完后才有内容）
- [ ] README 里的截图能正常显示（`docs/screenshots/` 下四张 PNG + 一张 GIF）
- [ ] 目录（TOC）里每个锚点都能跳到位
- [ ] 示例数据里没有真实账号：`git grep -n "example.com" README.md` 之类抽查几条

## 3. 打 tag 与发 Release

```bash
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

然后在 GitHub 上 Releases → Draft a new release → 选择刚推的 `v1.0.0` tag，标题填 `v1.0.0`，正文用下面这份草稿（和 `CHANGELOG.md` 的 v1.0.0 同源，可按需删减）：

```markdown
首个公开版本。把「QQ 群里真正需要你动手的通知」变成一张能勾、能提醒、能离线打开的待办清单。

## 这个版本能做什么

- 导入 QQ 导出的聊天记录，或通过 NapCat（OneBot 11）**只读**订阅实时群消息
- 每条消息判成「待办 / 不是待办 / 无法判定」三档，判不了的也留档可查
- 抽取截止日期与约束要点，附件（PDF/DOCX/TXT）抽正文，图片可选走多模态端点读字
- 到期待办推 QQ 私聊或 Web Push；`/api/calendar.ics` 可订阅进系统日历
- 手机浏览器加进主屏即是 PWA；数据就是本地一个 JSON 文件，备份脚本附恢复演练

## 跑起来

```bash
npm install
cp .env.example .env
npm start           # http://127.0.0.1:7788
npm test            # 全部自测
```

## 说明

- 默认离线 `stub` 规则引擎，零成本、结果确定；要更强的判定再配任何 OpenAI 兼容端点。
- 实时订阅默认关闭，开启后也只读，不会往群里发消息。
- 已知取舍写在 `docs/SPEC.md`，部署细节在 `deploy/README.md`。
```

## 4. 建议的 topics

在仓库首页 About → Topics 里填：

```
qq qqbot napcat onebot todo todo-list self-hosted pwa web-push nodejs llm openai-compatible pnpm-free zero-build
```

（按相关性挑 8–12 个即可，`pnpm-free` 这类冷门标签可去掉。）

## 5. 仓库设置建议

| 设置项 | 建议 | 理由 |
| --- | --- | --- |
| Description | 填一句话定位 | 搜索结果里唯一能看到的一句 |
| Website | **留空** | 没有公共实例时填了就是死链；等你有演示站再填 |
| Topics | 见上一节 | 决定别人能不能搜到 |
| Issues | 打开 | 已经放了 issue forms 与 `config.yml`（`blank_issues_enabled: false`） |
| Discussions | 可选 | 开了就要维护；不开的话 `config.yml` 里那条「使用问题」链接指向 README，仍然可用 |
| Wiki | 关掉 | 文档都在 `docs/`，两处并存必然不同步 |
| Security → Private vulnerability reporting | **打开** | `SECURITY.md` 里指的 GitHub Security Advisory 需要它才能用 |
| Actions | 保持开启 | CI 是唯一的自动门禁 |
| Releases | 只发正式 tag | 不用 `latest` 之类的移动 tag |

## 6. 发布后

- 把仓库地址补进 README 文末与 `package.json`，再推一次（或者在一个 `docs` 提交里做）。
- 第一次收到外部 PR 时，`PULL_REQUEST_TEMPLATE.md` 的检查项就是评审清单，照着核。
- 以后每次发版：改 `CHANGELOG.md` → 提 PR → 合并 → 打 tag → 复制 CHANGELOG 里对应小节做 Release 正文。
