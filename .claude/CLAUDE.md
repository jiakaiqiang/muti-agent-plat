# CLAUDE.md

本文档是 Claude 在当前仓库工作时的轻量入口。

## 必须先做

- 默认使用 Harness Engineering 完成用户任务。
- Harness Engineering 是约束 AI Agent 交付行为的外部工程模型，不是业务系统功能，边界见 `docs/harness-engineering/00-boundary-and-principles.md`。
- 除非用户明确要求产品化，否则不要把 Harness 写成后端模块、前端页面、API、数据库或运行时能力。
- Agent Cluster 的代码实现只是 Harness 的参考实例，不是定义来源。
- 先判断用户是在询问、讨论、review、排查、验证，还是要求实现。
- 用户明确说“只询问”“先讨论”“不要写代码”“不需要改代码”时，不要编辑文件。
- 不确定需求落点时，先读取项目地图，不要直接实现。
- 高风险、破坏性、外部副作用、提交、发布、部署等操作必须先请求用户确认。
- 日常犯错的操作或者步骤用户更新后都需要同步到这个文档中

## 轮次纪律：不要提前收工

2026-08-25 实测：一次会话里连续六轮只说「我去查 X」就结束轮次，零工具调用，
用户连喊六次「继续」。日志确认那六轮 `call=0`、`turn/end` 正常、传输失败 0 次
——不是断流，是自己收的工。以下三条是硬约束。

- **宣告和动作必须在同一轮。** 写下「我去看/我去查/先确认」之后，同一轮里必须
  发出工具调用。
- **工具结果回来后不要静默结束轮次。** 拿到结果就接着做下一步或给出结论，
  不要把轮次停在 `tool_result` 后面一句话都不说。
- **不要在同一轮里干完活又立刻标 goal complete。** 那会让 `activation` 变成
  `disarmed`，护栏当场消失。等用户确认目标达成再标。

## 停止/断流的两层护栏（环境不同，覆盖不同）

- **Claude Code CLI**：`~/.claude/hooks/` 两个 hook 挂在 `Stop` / `StopFailure`。
  `stall_autocontinue.py` 管传输断流（524 / `<synthetic>` / 缺 `stop_reason`），
  `stop_early_end.py` 管提前收工（复读 / 只写计划 / 报幕 / 工具后静默）。
  改完跑 `python ~/.claude/hooks/_test_stop_early_end.py`，退出码 0 为全绿。
- **DSH GUI / Desktop**：没有 hook 机制（无 hook 插件、代码对 `.claude` 零引用）。
  唯一护栏是 goal：`goal-round-driver` 在 agent idle + phase active + 续行已启用
  + 有剩余容量时自动续下一轮。唯一闸门在 `lib/index.js` L124-125，三条全过才续，
  达到 `maxGoalRounds` 时自动 `block`（code=`round-limit`），不是静默停。
  推论：**跑多步任务前先挂 goal**，否则这个环境里没有任何东西拦得住提前收工。
- **哪些结束原因会解除护栏**（两处代码合起来看，只看一处会判错）：
  `goal-round-driver` L263-272 的 `turn/end` 分支只处理 `max-tokens`（→`disarm`）
  和 `aborted`（→标 cancelled 或 `disarm`），其余 `return` 不动作；**但 L201-203
  还有个独立的 `agent/error` 处理器，无条件 `disarm`**。

  | `reason.kind` | 结果 |
  | --- | --- |
  | `completed` / `interrupted` | 不动作，**照续 ✓** |
  | `aborted` | 用户主动取消，阻止本次续接（合理） |
  | `max-tokens` | `disarm`，**永久解除** |
  | `error` | 伴随 `agent/error` → `disarm`，**永久解除** |

  `error` 那一行曾被我写成「照续」，是错的。`dsh-agent-loop` L582-589 是同一条
  路径：`catch` → `turnEnds={kind:'error'}` → `this.throwError()` → 发
  `agent/error`。对比 L574-580，`signal.aborted` 只 `throw` 不调 `throwError`，
  所以 `aborted` 不发 `agent/error` —— 这才是两者的真实差别。
- **`disarm` 是单向的**：driver 内没有任何 `arm`/`rearm`/`resume` 调用，
  解除后不会自愈。而 `resume` 在 `dsh-tool-goal` L343 走 `requireDirectHuman`，
  只认 `source.kind === "user"` 的真人消息；goal round 注入的 source 是
  `kind:"goal"`，过不了这道检查。**所以护栏一旦被解除，模型侧无法自救**，
  必须人类发话。这是 fail-closed 设计，不是缺陷。
  **推论**：`turn/end(error)` → `agent/error` → goal 被 `disarm`。
  传输/上游故障不只断一轮，还会把护栏一起带走，之后所有提前收工都无人接管。
  断流后先 `get_goal` 看 `activation`，是 `disarmed` 就先 `resume` 再干活。
- **降低护栏被解除概率的唯一可配项：`retryableCodes`**（2026-08-25 实测）。
  那次抽样到的 6 次轮次级 error 是 **HTTP 424** —— 正文为
  `No available accounts`（代理账号池耗尽）或 `Upstream request failed`。
  **但「全是 424，不是 524」这个断言是错的**（2026-08-29 修正）：剔除测试夹具后
  `stall_autocontinue.log` 里真实 524 有 17 条、424/429 有 12 条，两者都存在。
  而且它们**同根因**：账号池抽空时 Caddy 立刻拒绝就是 424/429，挂住连接排队等
  账号就是零字节产出 → Cloudflare 100s 读超时 → 524。所以 `retryableCodes`
  要把两条路径对应的分类码都覆盖，只按 424 配会漏掉 524。详见 memory
  `524-root-cause-proxy-account-pool.md`。
  不过**两个码的分类结果本来就不同**，这是下面那段只谈 424 的原因：
  `dsh-llm-pi-ai` 的 `classifyPiAiError` 对 `/\b5\d\d\b/` 归 `SERVER`，
  所以 524 落在默认可重试集合里、本来就会重试；424 匹配不上，
  落到兜底码 `PI_AI_ERROR`，而它不在默认集合
  `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` 里
  → **一次都不重试就判轮次失败并解除护栏**。
  所以单纯调大 `maxRetries` 对这类失败完全无效（我一度以为有效，是错的）。
  修法是在 `~/.dsh/settings.yaml` 的 provider 下显式重列并追加：
  ```yaml
  retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, PI_AI_ERROR]
  ```
  注意 `retryableCodes` 是**整体覆盖不是追加**，漏写默认项等于把它们关掉。
  安全性：`AUTH`(401/403)、`QUOTA`、`INVALID_REQUEST`(400/413) 在分类链里
  早于兜底就被分流，不会因此陷入无意义重试；`INVALID_CREDENTIAL` 被上游注释
  明确标为「故意排除」，不要加。
  改完用 `resolveRetryPolicy` 实解验证，别只看 yaml 文本。
- **重试预算是按 `(turn, step, provider, policyKey)` 算的，不是按轮次**
  （`dsh-llm-retry` 的 `recover()` 用这四项 `findLast` 上一条 `llm/retry`）。
  所以一个轮次里 8 个 step 各重试到 8 次，会看到 32+ 条重试事件而没有任何
  一次超限 —— 把同 turn 的重试条数直接相加当成"重试了 N 次"是错的对账口径
  （我一度据此以为超了 `maxRetries`）。判"预算是否打满"必须看**单 step 峰值**。
  另一个推论：`policyKey` 参与匹配，所以改 `settings.yaml` 会换 key，
  等于把当前 `(turn, step)` 的重试计数清零重新开始。
- **`retryableCodes` 修不了"重试完还是失败"**。实测 2026-08-26 09:24:39 那次
  轮次级报错是 HTTP 429（`All available accounts exhausted`），不是零重试，
  而是**单 step 预算打满 8/8** 且退避已顶到 `maxDelayMs=30000`。后果一样：
  `agent/error` → 护栏被解除。这是当天第一次**实测**到护栏真被解除
  （`get_goal` 返回 `activation: "disarmed"`），此前都是代码推论。
  已把 `maxRetries` 提到 12（最坏纯退避约 241s/step）。代价要知道：
  每次重试重新计费输入 token，且失败前的等待更长。
- **不要用 `mode: always` 去躲这个问题**，它是陷阱。`alwaysPolicySchema`
  只有 `mode` 和 `backoff`，**没有 `retryableCodes`、没有 `maxRetries`**；
  `recover()` L136 对 `always` 跳过码过滤，L141 的上限检查也只对 `normal` 生效。
  等于 `AUTH`/`QUOTA`/`CONTEXT_WINDOW_EXCEEDED` 这类必然重复失败的错误
  也被无限重试 —— 把"报错+人工 resume"换成"永久静默挂起且不抛错"，更糟。
- 还有一条本机未触发但真实存在的分支：`providerRetryAfterMs > maxDelayMs` 时
  `normal` 模式**立刻放弃**（不管预算还剩多少），`always` 才改用本地退避。
  本机上游不发 `Retry-After`（108 次重试事件里 0 次带该字段），换代理/上游后
  要重新确认，否则 `maxDelayMs` 设小反而会让可重试失败提前判死。
- 两侧不对称：**输出撞 `max-tokens` 被截断时 DSH 不自动续，
  而 CLI 的 `stop_early_end.py` 会续**（`REASON_MAX_TOKENS` 分支）。
- 两个验证脚本一律走 wrapper：`%USERPROFILE%\.dsh\verify-retry.cmd`（重试策略）
  和 `%USERPROFILE%\.dsh\verify-goal-driver.cmd`（自动续接）。
  **不要直接调同名 `.cjs`**：它们需要 node ≥ 24（`zstdDecompressSync`），系统
  node 是 v20，必须跑在 DSH 自带 Electron 下；而且**用 PowerShell 的 `$env:`
  在同进程里设 `ELECTRON_RUN_AS_NODE=1` 会 `exit=0` 但零输出**，在 cmd 里设才
  正常（实测两种形式一个 76 行一个 0 行，一度以为脚本坏了）。wrapper 已把变量
  设置和 exe 路径反查（安装路径含中文，不写死）都封进去，exe 找不到时可用
  `set DSH_EXE=<完整路径>` 覆盖。读会话日志时有四个已踩过的坑：
  1. **判据路径是 `e.data.source`，不是 `e.data.message.source`。**
     `user/message` 的 payload 顶层就是 `{content,id,role,source}`。写错位置会
     全部取到 `undefined`，得到「注入 0 次」的假阴性（实测踩过）。
     driver 写入的形状是 `{"kind":"goal","goalId":...,"revision":...,"round":N}`，
     模型正文伪造不出来，可作权威判据。
  2. **不要** grep 正文里的 `goal_round` 字样——会命中自己写的文字，得到假阳性
     （实测误报过 21 次注入）。
  3. 会话日志是追加式多帧 zstd，必须按 `0xFD2FB528` magic 切帧逐帧解，
     整体 `zstdDecompressSync` 只能拿到第一帧（约 1 个事件，看起来像日志是空的）。
  4. **`goal/change` 事件不带 `activation` 字段**（payload 只有
     `operation` / `goal{phase,revision,maxGoalRounds}` / `roundsStarted`），
     所以 `disarm` 在日志里**完全不留痕**，光看生命周期会以为护栏一直在。
     日志里唯一能反推的痕迹是**没有 `pause` 配对的 `resume`** ——
     `phase` 全程 `active`、变的只有 `activation`，那条 `resume` 必然是从
     `disarmed` 恢复的。要确认护栏当前是否还在，只有 `get_goal` 的
     `activation` 是权威。
  交叉验证手段：`get_goal` 的 `roundsStarted` 应与注入次数一致。

## 条件加载

开始任务后，按需读取：

```text
docs/ai-agent-context/README.md
docs/ai-agent-context/project-map.md
docs/ai-agent-context/harness-engineering-protocol.md
docs/ai-agent-context/tool-workflow-rules.md
```

加载规则：

- 普通实现类任务：读 `README.md`、`project-map.md`、`harness-engineering-protocol.md`。
- 只讨论工具工作流：读 `tool-workflow-rules.md` 和 `harness-engineering-protocol.md`。
- 只询问项目情况：读 `project-map.md` 和相关项目文档，不编辑文件。
- 涉及具体模块：只读取项目地图指向的相关代码、合同、测试和文档。
- 讨论或维护 Harness 本体：读 `docs/harness-engineering/00-boundary-and-principles.md` 和 `docs/harness-engineering/README.md`。

## 永久记忆位置

不要把所有长期规则堆到本文件。

- AI 工具工作方式：`docs/ai-agent-context/`
- Harness Engineering 规程：`docs/harness-engineering/`
- 产品范围：`docs/product/agent-cluster-prd-v1.md`
- 系统设计：`docs/design/agent-cluster-system-design-v1.md`
- 功能状态：`docs/analysis/feature-inventory-and-status-v1.md`
- 合同：`docs/contracts/`
- 质量验收：`docs/quality/`
- 运维开发：`docs/devops/`

## 本地开发

- 后端 dev 不使用 watch，`apps/server/scripts/dev-entry.mjs` 固定 `sourceWatch=disabled`。
- 不要引入 watch、nodemon、`tsc --watch`、`--watch` 等自动重启方案。
- 改完后端代码后手动执行 `npm run dev:restart-server`。
- 前端由 Vite HMR 自动生效。前端已热更但后端未重启时，新接口会 404（如 `Cannot GET /api/...`），先重启后端再排查代码。

## 验证

根据任务选择最小有效验证集合：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
```

只改文档时可以不跑完整测试，但最终回复必须说明。

