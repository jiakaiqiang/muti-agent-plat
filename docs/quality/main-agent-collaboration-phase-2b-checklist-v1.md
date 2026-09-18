# 阶段 2B：版本化长期记忆、增量摘要与历史需求召回 — Checklist v1

> 日期：2026-09-16
> 状态：通过（2026-09-18）；7/7 AC 已有执行证据。
> 依赖：阶段 2A 通过；使用阶段 1 生命周期/取消屏障。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2b-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2b-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P2B-AC1 | P2B-T1、P2B-T3、P2B-T6 | 压缩前后原始消息可追溯；摘要说“已批准”但无有效确认记录时禁止启动工作流。 | 通过：store 原文保留、DecisionRecord 权威派生及 memory-confirm E2E。 |
| P2B-AC2 | P2B-T1、P2B-T2、P2B-T6 | 两个 worker 同时摘要同一范围只提交一个检查点；重启后从已覆盖位置继续，不重复总结全部历史。 | 通过：file 并发/重建单测；PostgreSQL 跨实例唯一提交 11/11 集成集。 |
| P2B-AC3 | P2B-T1、P2B-T2、P2B-T3、P2B-T6 | 摘要生成期间用户将 CSV 改为只支持 Excel，旧结果只能丢弃/重建，后续上下文仅以新决定为准。 | 通过：stale version 拒绝；旧 CSV 事实剔除、当前 Excel 约束/验收保留；superseded 来源可回查但不注入。 |
| P2B-AC4 | P2B-T4、P2B-T6 | 一百个历史需求中问及早期需求，可返回相关候选与来源；两个相似需求时不擅自切换；不拼接全部摘要。 | 通过：100 WorkItem/1,000 消息 fixture，候选最多 5，Intent Snapshot < 40 KB，相似项要求澄清。 |
| P2B-AC5 | P2B-T4、P2B-T5、P2B-T6 | 相同 agentId 的另一会话私有记忆不被检索；索引故障显示召回受限，允许指定需求而不猜测。 | 通过：跨 Session 隔离、显式引用优先和 `index_unavailable` 固定语料测试。 |
| P2B-AC6 | P2B-T2、P2B-T3、P2B-T6 | 长对话压缩后仍能找到被否决方案和当前验收标准；取消摘要后无迟到写入。 | 通过：阶段/需求/24 事件阈值、当前验收保留、generation/admission 拒绝；取消/恢复 E2E。生成失败不自动重放模型调用，持久化提交重试最多 3 次。 |
| P2B-AC7 | P2B-T5、P2B-T6 | 历史数量增长不要求每次扫描并装载全部正文；CLI 新上下文读检查点后不会重复已经完成的文件写入/外部调用。 | 通过（有边界）：PostgreSQL 数据库分页、file 有界页/32 页 LRU、CLI WorkItem/generation 隔离和轮换去重；file 启动仍加载完整投影，见 §6。 |

## 2. 现有验证入口

以下命令均于 2026-09-18 从仓库根目录执行。E2E 使用隔离文件/mock；PostgreSQL 脚本创建一次性数据库并在结束后删除，不连接真实模型。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/memory/summary-checkpoint-store.spec.ts apps/server/src/modules/memory/summary-checkpoint.service.spec.ts apps/server/src/modules/memory/summary-memory-derivation.spec.ts apps/server/src/modules/context-management/work-item-recall.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts apps/server/src/modules/runtimes/runtime.service.spec.ts apps/server/src/modules/persistence/relational/relational-schema.spec.ts apps/server/src/modules/events/events.controller.spec.ts apps/server/src/modules/events/events.service.spec.ts apps/server/src/modules/orchestrator/orchestrator.service.spec.ts
node scripts/test-session-persistence-postgres.mjs
npm run test:e2e:memory-confirm
npm run test:e2e:token-budget
npm run test:e2e:work-item-budget-recovery
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:session-delete
npm run typecheck
npm run test
npm run test:harness
npm run build
```

相关既有测试：

- [build-envelope-from-context-assembly.spec.ts](../../apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts)
- [runtime.spec.ts](../../packages/local-runtime-cli/src/runtime.spec.ts)

## 3. 必须补充的测试

- [x] 增量摘要跨进程唯一提交/旧版本拒绝：SummaryCheckpoint store/service 单测 + 独立 PostgreSQL 跨实例集成。
- [x] 历史需求检索和来源追溯固定语料：100 WorkItem/1,000 消息、相似候选、跨 Session、索引不可用。
- [x] CLI 上下文轮换不重播副作用：RuntimeService 覆盖跨 WorkItem/generation、阈值轮换及 LogicalOperation 去重。

## 4. 跨阶段安全复核

- [x] file/PostgreSQL 返回行为对等；独立 PostgreSQL 使用三个服务实例验证唯一提交、迟到拒绝和分页。内存模型差异记录于 §6。
- [x] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [x] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [x] 本阶段无新增 UI 状态；Web/Desktop 共享合同全量测试通过，各自样式未改动。
- [x] 测试输出与指标只含 fixture/稳定错误码，不记录凭据、完整敏感提示或真实用户正文。
- [x] 文档/合同已与实际实现同步；关闭摘要派生时保留原文、权威决定和上一有效检查点，未执行部署回退。

## 5. 证据记录

| 证据 | 环境/fixture | 结果 |
| --- | --- | --- |
| 2B 定向回归 | Windows、Node 20、file/stub；上述 11 个 spec | 176/176，通过，退出码 0。 |
| PostgreSQL | `test-session-persistence-postgres.mjs` 一次性数据库、独立连接/实例 | 11/11，通过；含跨实例唯一检查点、迟到旧版本拒绝、事件分页；数据库已删除。 |
| 关键 E2E | mock + 隔离 data file | memory-confirm、token-budget、work-item-budget-recovery、cancel、recovery、session-delete 全部退出码 0。 |
| 全仓门禁 | 当前工作树 | `typecheck`、`test`、`test:harness`、`build` 全部退出码 0；构建仅有既有 Vite chunk/第三方注释警告。 |
| 空白检查 | `git diff --check` | 仅报告既有 `context-management.service.spec.ts` 文件末空行；本阶段未擅自清理。 |

阶段通过条件已满足：长会话只注入当前有效事实，旧需求可有界召回，迟到摘要不能覆盖新决定，取消与 CLI 轮换不重播副作用，最终输入继续经过阶段 2A 预算门禁。

## 6. 已知限制与非证据

- file backend 为本地开发/隔离测试实现：进程启动时读取完整 JSON，`EventsService` 仍保留完整事件投影。其分页和 LRU 证明请求/缓存有界，不证明启动内存随历史常量增长。
- PostgreSQL 路径已证明数据库分页，但服务仍保留部分兼容投影供既有同步领域逻辑使用；彻底按域懒加载需要独立持久化重构，不能由本 Checklist 冒充完成。
- 未执行真实付费/多模态 Provider、外部语义检索、部署或发布；这些不计为本阶段通过证据。
