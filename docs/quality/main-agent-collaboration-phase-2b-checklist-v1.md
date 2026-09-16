# 阶段 2B：版本化长期记忆、增量摘要与历史需求召回 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 2A 通过；使用阶段 1 生命周期/取消屏障。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2b-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2b-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P2B-AC1 | P2B-T1、P2B-T3、P2B-T6 | 压缩前后原始消息可追溯；摘要说“已批准”但无有效确认记录时禁止启动工作流。 | 待验证 |
| P2B-AC2 | P2B-T1、P2B-T2、P2B-T6 | 两个 worker 同时摘要同一范围只提交一个检查点；重启后从已覆盖位置继续，不重复总结全部历史。 | 待验证 |
| P2B-AC3 | P2B-T1、P2B-T2、P2B-T3、P2B-T6 | 摘要生成期间用户将 CSV 改为只支持 Excel，旧结果只能丢弃/重建，后续上下文仅以新决定为准。 | 待验证 |
| P2B-AC4 | P2B-T4、P2B-T6 | 一百个历史需求中问及早期需求，可返回相关候选与来源；两个相似需求时不擅自切换；不拼接全部摘要。 | 待验证 |
| P2B-AC5 | P2B-T4、P2B-T5、P2B-T6 | 相同 agentId 的另一会话私有记忆不被检索；索引故障显示召回受限，允许指定需求而不猜测。 | 待验证 |
| P2B-AC6 | P2B-T2、P2B-T3、P2B-T6 | 长对话压缩后仍能找到被否决方案和当前验收标准；取消摘要后无迟到写入。 | 待验证 |
| P2B-AC7 | P2B-T5、P2B-T6 | 历史数量增长不要求每次扫描并装载全部正文；CLI 新上下文读检查点后不会重复已经完成的文件写入/外部调用。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/orchestrator/orchestrator.service.spec.ts
npm run test:e2e:memory-confirm
npm run test -w @agent-cluster/local-runtime-cli
```

相关既有测试：

- [build-envelope-from-context-assembly.spec.ts](../../apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts)
- [runtime.spec.ts](../../packages/local-runtime-cli/src/runtime.spec.ts)

## 3. 必须补充的测试

- [ ] 增量摘要跨进程唯一提交/旧版本拒绝测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 历史需求检索和来源追溯固定语料测试（待新增；不能用现有冒烟脚本代替）。
- [ ] CLI 上下文轮换不重播副作用测试（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：长会话可继续、旧需求可追溯、旧摘要不能覆盖新决定、取消与 CLI 交接不重播副作用；最终输入通过 2A 预算。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
