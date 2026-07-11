# Engineering Runtime Watchdog 参数基线

> 日期：2026-07-10
> 状态：指标采集、超时诊断、采样脚本和基线分析器已完成；每个目标 Runtime 至少 20 次真实 staging 运行尚未执行
> 适用范围：Codex app-server 与 Claude Code stream-json 流式 Runtime

## 1. 当前安全默认值

以下值是代码默认值和初始灰度值，不是已经由生产样本确认的推荐值：

| Runtime | first-frame | idle | absolute |
| --- | ---: | ---: | --- |
| Codex | 30,000 ms | 600,000 ms | 默认关闭 |
| Claude Code | 30,000 ms | 600,000 ms | 默认关闭 |

配置项：

```dotenv
CODEX_RUNTIME_FIRST_FRAME_TIMEOUT_MS=30000
CODEX_RUNTIME_IDLE_TIMEOUT_MS=600000
CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS=
CLAUDE_CODE_FIRST_FRAME_TIMEOUT_MS=30000
CLAUDE_CODE_IDLE_TIMEOUT_MS=600000
CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS=
```

- first-frame 和 idle 必须是 1～2,147,483,647 ms 范围内的整数；非法值回退到代码默认值。
- absolute 为空、未设置、`0` 或负数时关闭。
- absolute 只有在成本或合规上限得到明确批准后才允许启用。
- 参数仅作用于 `ENGINEERING_RUNTIME_STREAMING=codex|all` 的流式路径；`off` 继续使用 legacy 路径。

## 2. 可观测性合同

每次流式运行都会在 `AgentRunResult.streamMetrics` 和 Runtime invocation 中记录：

- `startedAt`、`completedAt`、`durationMs`。
- `frameCount`、`firstFrameAt`、`firstFrameLatencyMs`。
- `lastActivityAt`、`maxInterFrameGapMs`。

发生 `RUNTIME_TIMEOUT` 时，`error.details` 和失败事件 metadata 记录：

- `watchdog`：`first_frame | idle | absolute`。
- `runtimeType`、`runId`、`phase`、`thresholdMs`。
- `startedAt`、`lastActivityAt`、`timedOutAt`。
- `elapsedMs`、`idleForMs`、`firstFrameSeen`。
- `stderrTailSummary`：去除 ANSI/控制字符并限制为 1,000 字符的摘要，不保存完整 stderr。

## 3. 真实采样前置条件

真实 CLI 运行会产生模型费用和外部调用。执行前必须单独确认：

1. 隔离 staging workdir，不使用用户生产源码目录。
2. CLI 版本、登录账号、模型和区域配置已记录。
3. 本轮允许运行的 Runtime、次数和费用上限已获批准。
4. 日志和报告目录不包含凭据；报告只保留用量、时延、事件类型和脱敏错误。
5. 每个需要给出生产参数的 Runtime 至少完成 20 次独立运行；失败样本单独保留，不计入完成样本分位数。

## 4. 执行 20 次采样

仓库提供 20 个只读、不同复杂度的示例任务：

```text
tests/e2e/fixtures/watchdog-staging-scenarios.example.json
```

以 Claude Code 为例：

```powershell
$env:RUN_REAL_CLI_ACCEPTANCE='true'
$env:REAL_CLI_PHASE='sample'
$env:REAL_CLI_RUNTIME='claude_code'
$env:REAL_CLI_RUNS_PER_RUNTIME='20'
$env:REAL_CLI_SAMPLE_GOALS_PATH='tests/e2e/fixtures/watchdog-staging-scenarios.example.json'
$env:REAL_CLI_ACCEPTANCE_REPORT_PATH='.cache/agent-cluster/watchdog-claude-samples.json'
npm run test:e2e:real-cli-acceptance
```

Codex 采样时把 `REAL_CLI_RUNTIME` 改为 `codex` 并使用独立报告路径。当前 Codex 上游仍返回 `upstream_400` 时，不应反复重试或把失败样本当作时延基线。

采样模式具备以下保护：

- 未设置 `RUN_REAL_CLI_ACCEPTANCE=true` 时拒绝运行。
- `REAL_CLI_RUNS_PER_RUNTIME` 小于 20 时拒绝进入 `sample`。
- 示例目标数少于运行次数时拒绝执行。
- 每次运行使用独立 run id，只在一次性 workdir 内注入说明文件，并核验逐字节恢复。

## 5. 生成基线报告

```powershell
$env:WATCHDOG_SAMPLE_REPORT_PATH='.cache/agent-cluster/watchdog-claude-samples.json'
$env:WATCHDOG_RUNTIME='claude_code'
$env:WATCHDOG_MIN_SAMPLES='20'
$env:WATCHDOG_BASELINE_OUTPUT_PATH='.cache/agent-cluster/watchdog-claude-baseline.json'
$env:WATCHDOG_BASELINE_MARKDOWN_PATH='.cache/agent-cluster/watchdog-claude-baseline.md'
npm run report:watchdog-baseline
```

分析器输出首帧、最大帧间隔和总时长的 P50/P95/P99/max，并使用以下初始规则给出候选值：

- first-frame：`max(30s, P99 × 1.5, P95 + 5s)`，向上取整到 5 秒。
- idle：`max(60s, 帧间隔 P99 × 2, 帧间隔 P95 + 30s)`，向上取整到 30 秒。
- absolute：保持关闭。

候选值仍需经过慢任务和故障注入复核，不能直接等同于生产批准值。

## 6. 发布与回滚

1. 只调整一个 Runtime 的一类阈值并灰度观察，不同时修改所有参数。
2. 保留上一组环境变量和值、变更时间、责任人和样本报告路径。
3. 检查 timeout invocation 是否包含完整诊断字段，且没有泄露完整 stderr 或凭据。
4. 出现正常任务误杀时立即恢复上一组值并重启受影响实例。
5. 出现长时间无活动但未终止时，先检查配置是否被正确加载，再评估缩短 idle；不得用默认开启 absolute 代替根因分析。
6. 回滚后重放同一类只读 staging 场景，并保留变更前后证据。

## 7. PR-05 完成门槛

PR-05 只有在以下条件全部满足后才可标记完成：

- 代码、单测、流式 stub e2e 和配置样例通过。
- 每个进入生产参数表的 Runtime 至少有 20 次真实 completed 样本。
- 基线报告、最终批准值、回滚演练和责任人记录齐全。
- 真实慢任务持续产生事件且总时长超过 120 秒时不会被 idle watchdog 误杀。
- first-frame、idle 和 absolute 故障能够被区分，并包含规定的脱敏诊断字段。

当前仅第一项已完成，因此 PR-05 状态仍是“实施完成、真实数据验收待执行”。
