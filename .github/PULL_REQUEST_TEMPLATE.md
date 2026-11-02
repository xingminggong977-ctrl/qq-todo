## 这个 PR 做了什么

<!-- 一句话说清。修 bug 的话，先写清楚修的是哪个现象。 -->

## 为什么这么做

<!-- 备选方案是什么，为什么没选它。评审时最贵的成本是猜你的思路。 -->

## 检查项

- [ ] `npm test` 全绿（文件数与断言数贴在下面的「测试输出」里）
- [ ] `npm run smoke` 通过
- [ ] `node scripts/check-secrets.mjs` 0 命中：没有提交 `.env`、真实域名/IP/QQ 号/群号/密钥/本机路径
- [ ] 改了行为就补了测试（新增或修改的断言在 `fixtures/selftests/` 或 `src/live/_test/`）
- [ ] 没引入新的运行时依赖；如果引入了，理由写在上面「为什么这么做」
- [ ] 涉及判定口径的改动，说明了对 `todo` / `noise` / `error` 三档的影响
- [ ] 文档同步了（README 配置表、`docs/SPEC.md`、`CHANGELOG.md` 按需）

## 测试输出

```
$ npm test
...
```

## 关联 issue

Closes #
