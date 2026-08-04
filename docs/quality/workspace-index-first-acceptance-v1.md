# Workspace Index First 验收报告 V1

> 对应设计：[`../design/workspace-index-first-on-demand-context-system-design-v1.md`](../design/workspace-index-first-on-demand-context-system-design-v1.md)  
> 对应实施：[`../implementation/workspace-index-first-on-demand-context-development-v1.md`](../implementation/workspace-index-first-on-demand-context-development-v1.md)

## 1. 验收结论

功能主链路已经恢复为 Index First + On-demand Evidence。Session 创建不再同步扫描，Index 完成先后不再构成群聊门禁，所有 Runtime 阶段都能在证据不足时按预算补读。同一 Workspace 允许多个活动 Session，写任务由隔离目录和 FIFO 写回保护。

发布结论分两层：

- 功能、合同、安全和自动化回归：以本报告列出的测试命令为准。
- 100K 真实文件绝对性能：必须在固定 Windows 机器和已声明磁盘类型上补跑；CI 的 100K metadata summary 只做规模解耦回归门禁。

## 2. 功能验收映射

| 设计项 | 状态 | 自动化证据 |
| --- | --- | --- |
| AT-01 至 AT-05 快速授权/创建/讨论 | Covered | `packages/local-runtime-cli/src/transport.spec.ts`、`apps/server/src/modules/sessions/sessions.service.spec.ts`、`tests/e2e/workspace-index-first-smoke.mjs` |
| AT-06 至 AT-11 元数据索引 | Covered | `packages/local-runtime-cli/src/workspace.spec.ts`、`apps/server/src/modules/workspaces/server-local-workspace-index.spec.ts` |
| AT-12 至 AT-15 Context v2 Index/L3/预算 | Covered | `apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts`、Context v2 Harness |
| AT-16 至 AT-21 directory/search/read/预算/超时 | Covered | `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts` |
| AT-22 补读重试上限 | Covered | `apps/server/src/modules/orchestrator/supplemental-context-retry.spec.ts` |
| AT-23 索引晚完成不阻塞 | Covered | `tests/e2e/workspace-index-first-smoke.mjs`、`tests/e2e/server-local-project-analysis-smoke.mjs` |
| AT-24 至 AT-25 revision 变化/不稳定 | Covered | `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`、服务端项目分析 E2E |
| AT-26 至 AT-29 多 Session/终态/恢复 | Covered | `apps/server/src/modules/sessions/sessions.service.spec.ts`、`apps/server/src/modules/worktree-execution/worktree-execution.service.spec.ts`、`tests/e2e/workspace-index-first-smoke.mjs` |
| AT-30 写回冲突 | Covered | Workspace ChangeSet、三方合并、写回服务单元测试与 `tests/e2e/server-local-source-conflict-guard-smoke.mjs` |
| AT-31 Local Runtime 断线 | Covered | `tests/e2e/browser-local-runtime-cli-e2e.mjs`、Recovery E2E |
| AT-32 敏感路径与边界 | Covered | Workspace sensitive/symlink/path 测试、`tests/e2e/security-smoke.mjs` |

调试与可观测性额外由 `apps/server/src/modules/runtimes/runtime.service.spec.ts`、`apps/web/src/components/debug-runtime-v2-only.spec.ts` 和 `apps/server/src/common/workspace-metrics.spec.ts` 覆盖。运行时调用日志持久化 index generation/status/complete、起始 revision、补读次数/耗时、证据字节数和路径；`GET /ops/workspace-metrics` 暴露设计规定的 11 项无正文聚合指标。

增量索引另外覆盖 Windows watcher 把子文件变更上报为父目录 metadata 事件的情况：Local Runtime 与 Server Provider 都必须保留既有子树，并在完整基线仍成立时保持 `ready/complete=true`。

任务查询回归还验证有界结果会同时包含基础入口与词法相关文件：例如架构任务命中 `src` 文件时，`package.json` 仍保留在投影中；查询过程不读取正文或计算内容 hash。

## 3. 关键真实链路

### 3.1 快速创建

`tests/e2e/workspace-index-first-smoke.mjs` 创建包含 500 个源码文件的临时目录并验证：

- `POST /sessions` 小于 1s。
- 创建响应没有同步生成的 `workspaceSnapshot`。
- 响应包含 `server_local` Binding 和首条 `user_message`。
- 第二个活动 Session 创建成功，拥有独立 Session id，并绑定同一 `workspaceId`。

### 3.2 索引晚于分析

`tests/e2e/server-local-project-analysis-smoke.mjs` 验证：

- Session 在 Index 未完整时启动。
- `brief_generation` 的 Evidence Gate 触发自动补读，而不是把 Session 直接置为失败。
- 架构任务首次执行前只允许最多 8 文件、256KB、1.5s 的入口预读；超时或 Provider 不可用时继续现有索引流程，不等待完整扫描。
- 已读 `package.json/src/main.ts/src/App.vue` 进入当前 revision 的 L3。
- 明确写报告后 watcher 推进 revision，post-review 淘汰旧证据并重新取证。
- 最终报告识别 Node/Vue/Vite，且只写入 Workspace 内授权路径。

## 4. 性能验收

| 设计项 | 当前自动化 | 发布要求 |
| --- | --- | --- |
| PERF-01 Workspace 注册 | 100K metadata Index Summary，验证 P95 < 500ms 且不序列化 entries | 固定盘 100K 真实目录复测 |
| PERF-02 Session 创建 | 100K Index Summary，验证 P95 < 1s | 固定盘 + 已连接 Local Runtime 复测 |
| PERF-03 规模稳定性 | 1K/10K/100K Summary，最大 P95 不超过最小值 2 倍（含 5ms 抖动容差） | 固定环境记录绝对值 |
| PERF-04 Index 状态 | empty/building/ready P95 差值 < 300ms | 保持 CI 门禁 |
| PERF-05 单文件补读 | 64KB 上限由单元与 E2E 覆盖 | 发布前采集 Local Runtime P50/P95 |
| PERF-06 有界搜索 | 10s deadline 和结构化超时由单元覆盖 | 100K 真实目录采集 P50/P95 |
| PERF-07 后台索引心跳 | Runtime 心跳与非阻塞索引测试覆盖行为 | 发布前采集事件循环延迟 |

运行：

```bash
npm run test:perf:workspace-session-create
```

输出包含机器、OS、Node、CPU、磁盘说明、样本数、P50/P95、规模比和状态差值。没有设置 `WORKSPACE_PERF_DISK_TYPE` 时，报告明确为 `unknown`，不得当作发布绝对性能证据。

## 5. 发布阻断核对

| 阻断项 | 结果 |
| --- | --- |
| Session 创建触发递归扫描/批量正文 | 已移除 |
| 无 L3 正文仍允许源码结论成功 | Evidence Gate 阻断并自动补读 |
| Supplemental 无时间/字节/重试上限 | 10s/512KB/2 轮 |
| 架构分析因入口文件补读长期等待 | 首次预读限制为 1.5s/8 文件/256KB，失败后继续 |
| 同 Workspace 多活动 Session 无隔离 | Git worktree / non-Git staging copy + FIFO 写回 |
| Local Runtime 断线静默切 Server | 禁止 |
| sensitive/symlink/Workspace 边界失败 | 纳入聚合测试 |
| PERF-01/02/03 CI 回归失败 | 聚合性能命令失败 |

## 6. 验证命令

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
npm run test:e2e:main-chain
npm run test:e2e:multi-agent-discussion
npm run test:e2e:workspace-snapshot-payload
npm run test:e2e:server-local-project-analysis
npm run test:e2e:workspace-index-first
npm run test:perf:workspace-session-create
```

验收报告只在上述命令实际通过后标记本次工作树可进入发布候选；固定磁盘性能证据仍需单独归档。

## 7. 2026-07-29 验证记录

本次工作树已通过：

- `npm run typecheck`
- `npm run test`：Shared、Local Runtime、Server、Web 与开发 Supervisor 全部通过；Local Runtime 30 passed，Server 1043 passed / 4 skipped，Web 134 passed。
- `npm run test:harness`
- `npm run build`
- `npm run test:workspace-index-first -w @agent-cluster/server`：168 passed。
- `npm run test:e2e:workspace-index-first`
- `npm run test:e2e:main-chain`
- `npm run test:e2e:multi-agent-discussion`
- `npm run test:e2e:workspace-snapshot-payload`
- `npm run test:e2e:server-local-project-analysis`
- `npm run test:e2e:browser-local-runtime-cli`
- `npm run test:e2e:ops`
- `npm run test:perf:workspace-session-create`

本轮 100K metadata summary 性能结果：Workspace 注册 P95 `0.018ms` 且未序列化 entries；Session 创建 P95 `0.242ms`；1K/10K/100K 规模比 `1.105x`；`empty/building/ready` 状态 P95 差值 `0.004ms`。测试机器磁盘类型仍为 `unknown`，因此这些结果只证明创建路径与项目规模解耦，不替代固定磁盘发布基准。

构建只有 Vite 既有的大 chunk 警告；主链 smoke 仍会记录 `runtime-smoke-session` 不存在的既有 404 警告，但命令退出码为 0。两者不影响本设计的功能验收。固定 Windows 磁盘上的 100K 真实文件 PERF-01 至 PERF-03 绝对值，以及 PERF-05 至 PERF-07 的发布环境采样，仍属于发布前外部环境验收，不属于本次 CI 结果。
