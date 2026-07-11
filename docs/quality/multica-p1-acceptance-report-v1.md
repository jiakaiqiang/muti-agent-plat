# Multica 对标改造 P1 验收报告 v1

> 日期：2026-07-10
> 状态：部分完成；PR-06 已通过，PR-05 工程实现已通过定向验证；剩余真实验收已纳入计划但暂不启动
> 闭环结论：P1 尚未完成，P0/P1 统一闭环尚未形成，P2 继续冻结

## 1. 验收总览

| 编号 | 验收项 | 状态 | 主要证据 |
| --- | --- | --- | --- |
| PR-05 | Watchdog 参数与可观测性基线 | 部分通过 | Runtime stream metrics、timeout 诊断、配置解析、真实采样模式、基线分析器和单测已完成；每个目标 Runtime 20 次真实采样与回滚演练待执行 |
| PR-06 | Skill 管理前端 | 通过 | Web 组件测试 2/2、浏览器端到端创建/文件/绑定/注入/删除验证和 Web build 通过 |

## 2. PR-05 Watchdog

### 2.1 已实现

- `AgentRunResult.streamMetrics` 记录开始/完成时间、总时长、帧数、首帧时延、最后活动时间和最大帧间隔。
- RuntimeService 把 stream metrics 持久化到 invocation，完成运行也可以用于参数分位数分析。
- first-frame、idle、absolute timeout 统一输出 runtime、runId、phase、阈值、活动时间、elapsed/idle 时长、首帧状态和脱敏 stderr 摘要。
- Codex/Claude 分别支持 first-frame、idle 和 absolute 环境变量；absolute 默认关闭。
- `REAL_CLI_PHASE=sample` 强制每个 Runtime 至少 20 次真实运行，并要求提供等量只读任务。
- 基线分析器输出首帧、最大帧间隔和总时长的 P50/P95/P99/max，以及候选 first-frame/idle 参数；absolute 不自动启用。

### 2.2 已通过证据

```text
npm run test --workspace @agent-cluster/server  338/338 PASS
npm run test:watchdog-baseline                 2/2 PASS
```

服务端测试包括：

- 持续收到帧且总时长超过 120 秒时不触发 idle timeout。
- first-frame、idle、absolute 原因区分和详细 observation。
- timeout details 字段与 stderr 脱敏/长度限制。
- Codex/Claude runner 的 timeout 映射和 stream metrics。
- Runtime invocation 的 stream metrics 持久化。
- 环境变量非法值回退和 absolute 默认关闭。

### 2.3 尚未通过

- 尚未获得本轮至少 20 次真实 CLI 调用的成本批准，因此未执行真实采样。
- 尚未根据真实样本生成并批准生产参数表。
- 尚未用最终候选值执行 staging 慢任务、无首帧、idle 卡死和回滚演练。

PR-05 不能因为代码和 stub 测试通过而标记完成。执行手册见 [`../devops/watchdog-baseline.md`](../devops/watchdog-baseline.md)。

## 3. PR-06 Skill 管理前端

### 3.1 已实现

- 工作台新增 Skill 管理入口和列表/详情布局。
- 支持创建、编辑、删除 name、description、content 和多文件内容。
- 提交前检查必填字段、路径穿越、绝对路径、重复路径和文件大小，并显示服务端字段错误。
- 支持 Agent 绑定/解绑；删除前列出受影响 Agent，删除后刷新并移除悬空引用。
- 注入预览展示稳定顺序、文件路径和内容摘要，不展示不必要的完整敏感内容。

### 3.2 已通过证据

```text
npm run build --workspace @project/web          PASS
npm run test --workspace @project/web           2/2 PASS
npm run test:e2e:skill-management               PASS
```

浏览器 e2e 覆盖：

1. 在真实页面创建 Skill 并添加文件路径/内容。
2. 绑定真实 Agent 并检查注入预览不泄露完整内容。
3. 创建下一会话并检查 ContextPack 包含 `[Skill:Release Checklist]`。
4. 删除前检查受影响 Agent，删除后确认 Agent `skillIds` 已清理。

PR-06 验收结论为通过。

## 4. 完整质量门

本轮 P1 增量完成后，以下命令已通过：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
npm run test:e2e:workspace-chrome
npm run test:e2e:chinese-copy
npm run test:e2e:real-data-mode
npm run test:e2e:skill-injection
npm run test:e2e:codex-streaming
npm run test:e2e:claude-streaming
npm run test:e2e:skill-management
```

结果：

- `npm run typecheck`：shared/server/web 全部通过。
- `npm run test`：server 338/338、Web 2/2 通过。
- `npm run test:harness`：Phase 1～5 全部通过。
- `npm run build`：shared/server/web 全部通过。
- 工作台、中文文案、真实数据模式、Skill 注入/管理、Codex streaming、Claude streaming 定向 e2e 全部通过。

## 5. 剩余动作与解锁条件

当前决策：以下动作只作为后续计划保留，暂不执行。必须收到用户明确的启动指令，并满足对应环境与成本授权后，才进入执行状态。

1. 按 `TASK-P1-05-WATCHDOG-STAGING-BASELINE` 明确批准真实采样的 Runtime、每个 Runtime 的运行次数和费用上限。
2. 在隔离 staging 执行每个目标 Runtime 至少 20 次 completed 样本。
3. 生成基线报告，评审并记录最终 first-frame/idle 值；absolute 默认保持关闭。
4. 使用最终候选值完成慢任务、卡死故障和配置回滚演练。
5. Codex 上游恢复后按 `TASK-P0-01-CODEX-REAL-ACCEPTANCE` 补齐 P0 PR-01 真实验收；Codex 的 Watchdog 采样依赖该任务先成功。
6. 汇总 P0/P1 最终报告并明确评审通过后，才允许为 P2 创建开发任务。

两个任务的完整执行定义见 [`../roadmap/multica-refactor-completion-execution-plan-v1.md`](../roadmap/multica-refactor-completion-execution-plan-v1.md)。
