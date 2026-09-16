# AGENTS.md

本文档是 Codex 和其他 AI 工程代理进入本仓库时的轻量入口。

## 必须先做

- 默认使用 Harness Engineering 完成用户任务。
- Harness Engineering 是约束 AI Agent 交付行为的外部工程模型，不是业务系统功能，边界见 `docs/harness-engineering/00-boundary-and-principles.md`。
- 除非用户明确要求产品化，否则不要把 Harness 写成后端模块、前端页面、API、数据库或运行时能力。
- Agent Cluster 的代码实现只是 Harness 的参考实例，不是定义来源。
- 先判断用户是在询问、讨论、review、排查、验证，还是要求实现。
- 用户明确说“只询问”“先讨论”“不要写代码”“不需要改代码”时，不要编辑文件。
- 不确定需求落点时，先读取项目地图，不要直接实现。
- 高风险、破坏性、外部副作用、提交、发布、部署等操作必须先请求用户确认。

## 轮次纪律：不要提前收工

2026-08-25 实测：一次会话里连续六轮只说「我去查 X」就结束轮次，零工具调用，
用户连喊六次「继续」。日志确认那六轮 `call=0`、`turn/end` 正常、传输失败 0 次
——不是断流，是自己收的工。以下三条是硬约束。

- **宣告和动作必须在同一轮。** 写下「我去看/我去查/先确认」之后，同一轮里必须
  发出工具调用。只报幕不干活 = 提前收工。
- **工具结果回来后不要静默结束轮次。** 拿到结果就接着做下一步或给出结论，
  不要把轮次停在工具回执后面一句话都不说。
- **不要在同一轮里干完活又立刻标记长任务目标完成。** 那会让自动续接机制当场
  失效，护栏消失。等用户确认目标达成再标。

不同环境的护栏覆盖不同，细节见 `.claude/CLAUDE.md` 的「停止/断流的两层护栏」。
各 CLI 的恢复能力（2026-08-25 实测，按能否阻止轮次结束区分）：

- **Claude Code**：`Stop` / `StopFailure` hook 读 stdout 决策，已装恢复 hook。
- **Gemini**：`~/.gemini/settings.json` 的 `general.hooks` 有 `SessionStart`、
  `Stop`、`PreToolUse`、`PostToolUse`。**具备 stdout 决策通道**（Orca 的
  `gemini-hook.cmd` 特意 `echo {}`，只有需要 CLI 解析 stdout 的 hook 才必须
  输出合法 JSON），但当前挂的是纯遥测，没做恢复。**可移植目标。**
- **Codex**：只有 `notify = [..., "turn-ended"]`，fire-and-forget，无 stdout
  决策通道，**无法阻止轮次结束**。只能靠外部 pane 控制重新注入。
- **Grok**：无任何 hook / stop / retry 配置。

除 Claude Code 外，上面三条纪律是这些环境里的唯一保障。

DSH GUI 的自动续接只有挂了长任务目标时才存在，所以跑多步任务前先挂目标，
并且不要在干完活的同一轮就标记完成。它还有两个会**永久解除**护栏的边界
（解除后不会自愈，只有人类 resume 能恢复）：

- **输出撞 token 上限被截断**：DSH 不自动续（CLI 的 hook 反而会续）。
- **轮次报错**：报错会连带解除护栏，不只是断一轮。而恢复只认真人消息，
  模型侧无法自救。所以报错之后要先确认目标是否还处于激活状态，
  已解除就先恢复再干活，否则后续提前收工无人接管。

  成因往往不是「重试耗尽」而是**一次都没重试**：2026-08-25 实测本机
  10 次轮次级报错全是 HTTP 424（代理账号池耗尽这类瞬时故障），
  却因为落到兜底失败码、而该码不在默认可重试集合里，直接判轮次失败。
  这种情况下调大重试次数毫无作用，要把该失败码显式加进
  `~/.dsh/settings.yaml` 的 `retryableCodes`（**整体覆盖语义，
  漏写默认项等于把它们关掉**），细节和安全边界见 `.claude/CLAUDE.md`。

验证入口（三个都不依赖本仓库依赖，可独立运行）：

```bash
# CLI 侧提前收工/断流 hook 回归，退出码 0 为全绿
python ~/.claude/hooks/_test_stop_early_end.py
# DSH 侧自动续接是否真的触发
%USERPROFILE%\.dsh\verify-goal-driver.cmd
# DSH 侧传输重试策略是否生效
%USERPROFILE%\.dsh\verify-retry.cmd
```

两个 `.cmd` 是 wrapper，照抄即跑。不要直接调同名 `.cjs`：它需要 node ≥ 24
（系统 node 是 v20），必须跑在 DSH 自带的 Electron 下，而且**用 PowerShell 的
`$env:` 在同进程里设 `ELECTRON_RUN_AS_NODE` 会 `exit=0` 但零输出**（实测踩过，
一度以为脚本坏了）。wrapper 在 cmd 里设变量并从运行中的 DSH 进程反查 exe 路径，
避开这两个坑。exe 找不到时用 `set DSH_EXE=<完整路径>` 覆盖。

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

## 验证

根据任务选择最小有效验证集合：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
```

只改文档时可以不跑完整测试，但最终回复必须说明。

