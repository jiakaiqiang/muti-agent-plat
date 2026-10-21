# 本地 Codex：当前意图识别与路由评测

入口是 `report.md`，详细变更见 `optimization-notes.md`，判分口径见 `rubric.md`。

## 证据目录

| 文件或目录 | 含义 |
|---|---|
| `baseline-a` 至 `baseline-d` | 优化前完整 20 题，每批 5 题 |
| `optimized-a` 至 `optimized-d` | 第一轮优化后完整复测 |
| `final-a` 至 `final-d` | 第二轮优化后完整复测 |
| `round1-report.md`、`round1-comparison.json` | 中间轮次的真实结果，保留失败项 |
| `comparison.json`、`scored-results.json` | 最终统一评分及逐题详情 |
| `baseline-semantic-router.js`、`baseline-build-hash.json` | 优化前实际构建的分类器副本及哈希 |
| 各批 `manifest.json` | 题集、产品源码哈希、模型和预算口径 |
| 各批 `results.json` | 实际快照、模型输出、编译结果、运行记录 |
| 各批 `provider-N.json`、`.jsonl` | 真实 CLI 调用输入、事件、输出、用量；没有保存认证密钥 |
| `pilot*` | 接入调试，排除在正式成绩之外 |

报告中的“全题通过”是诊断集的严格检查结果，不是生产准确率。路由拦截、后续执行和真实纠错提交应分别阅读，不能合并理解。

## 复测当前代码

先完成构建，再执行评测。脚本需要本地已经登录且可用的 Codex CLI，不修改本地连接配置。

```powershell
npm run build -w @agent-cluster/shared
npm run build -w @agent-cluster/server
node tests/evaluation/run-intent-codex-current.mjs --label=new-check-unique --limit=20
```

每次使用新的 label，脚本拒绝覆盖历史目录。CLI 入口默认使用本机已安装的 `~/.local/codex-cli/node_modules/@openai/codex/bin/codex.js`；其他安装位置可用 `INTENT_EVAL_CODEX_JS` 指定。运行会使用真实模型额度。

重新生成本次最终报告：

```powershell
node tests/evaluation/report-intent-codex-current.mjs --after=final
```

评测器只允许分类阶段、空工具目录和无写权限的运行计划；路由编译不会提交或派发业务操作。结果是服务级集成评测，不是原生 Codex 运行时支持证明，也不是 UI/HTTP 全链路验收。
