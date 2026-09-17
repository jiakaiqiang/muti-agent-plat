# 阶段 0：合同收敛、现状基线与迁移边界 — Checklist v1

> 日期：2026-09-16
> 状态：阶段 0 已实现并验证；6 条 AC 完成合同/基线验收，不表示后续业务入口或生产发布已完成。
> 依赖：无；作为所有阶段的入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-0-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-0-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-0-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P0-AC1 | P0-T1、P0-T2、P0-T5 | 给定两个会话使用同一 agentId，合同能唯一关联各自需求、调用、取消目标与产物。 | 通过：身份/作用域/分隔符碰撞单测；见 E1、冻结合同 §2 |
| P0-AC2 | P0-T2、P0-T3 | 逐一审核消息、确认、文档、流程启动的所有权矩阵，无两个组件同时拥有最终决定权。 | 通过：角色矩阵、系统 coordinator 唯一及越权归属拒绝单测；E1/E2、合同 §3 |
| P0-AC3 | P0-T3、P0-T6 | 主流程案例同时覆盖用户 @ 专家、主 Agent 咨询、成员选择、文档确认和用户选择流程。 | 通过：合同 §4/10 五个交互案例审查、精确确认单测；E1。不是端到端业务验证 |
| P0-AC4 | P0-T4、P0-T5 | 查阅类型、迁移、运行时合同，不引入 v1 回退、不把摘要或分类结果当作执行授权。 | 通过：只增量导出新类型/纯函数，保留既有 SessionStatus/InvocationPlan；E2/E5 与合同 §1/8 |
| P0-AC5 | P0-T1、P0-T5、P0-T6 | 清单列出现有停止/持久化能力、物理删除语义、摘要限制、讨论行为，以及对应源码和重新验证任务。 | 通过：新建现状/句柄/迁移基线；本轮 E3 重新验证，不复制旧专项结果 |
| P0-AC6 | P0-T4、P0-T6 | 旧构建不识别新状态时阻止接管；关闭新入口不删除新数据或放开停止屏障。 | 合同级通过：E1 模拟不支持版本/特性的读端、活动执行与未停稳拒绝；合同 §5～9 明确旧 writer 部署门禁。未部署旧二进制演练 |

## 2. 现有验证入口

以下命令从仓库根目录运行。本轮执行范围为纯函数/隔离 file 与 mock 基线；完整命令（含后端 8 个文件）见[基线 §6](../implementation/main-agent-collaboration-phase-0-baseline-v1.md)。未连接当前业务服务、真实数据库或模型。

```powershell
npm run test -w @agent-cluster/shared
npm run typecheck
npm run test:harness:main-agent-phase0
npm run test:harness
npm run build -w @agent-cluster/shared
```

相关既有测试：

- [system-agent-runtime-policy.service.spec.ts](../../apps/server/src/modules/agents/system-agent-runtime-policy.service.spec.ts)
- [context-management.service.spec.ts](../../apps/server/src/modules/context-management/context-management.service.spec.ts)
- [logical-operation-store.spec.ts](../../apps/server/src/modules/runtimes/logical-operation-store.spec.ts)
- [persistence-scoped-mutation.spec.ts](../../apps/server/src/modules/persistence/persistence-scoped-mutation.spec.ts)

## 3. 新增测试完成情况

- [x] 身份链/角色所有权/精确确认合同测试，见[共享合同测试](../../packages/shared/src/collaboration-contracts.spec.ts)。
- [x] 新旧读端版本、未知生命周期、墓碑、停止屏障、策略升级与不变快照的纯合同测试，共同包含于新增 15 项测试；不是旧客户端程序联调。
- [x] 9 阶段本地链接、AC→任务→验收追踪、动作矩阵文档、deferred 边界与脚本入口检查，见[阶段 0 Harness 检查](../../tests/harness-engineering/main-agent-collaboration-phase0.spec.mjs)，6 项通过。

## 4. 跨阶段安全复核

| 安全项 | 本阶段结论/后续要求 |
| --- | --- |
| file/PostgreSQL 对等及多实例竞争 | 本阶段无存储改动；E3 为已有 file/mock 回归，不代表真实 PostgreSQL 验证。阶段 1 新存储必须独立数据库验证 |
| 重复、乱序、重启、取消/删除、迟到结果 | E1 校验代次/版本，E3 覆盖已有租约/停止/幂等；完整生命周期端到端留阶段 1，不能标为已实现 |
| 未确认范围/高风险/未知停止不放行 | 合同明确不得用摘要/模型替代授权；E1 只验证纯函数拒绝，实际业务入口按所属阶段接入 |
| 双端一致且保持独立样式 | 本轮不改 UI/store/events，未执行双端 E2E；阶段 1/6 验证新增业务 |
| 敏感数据 | 已复核 fixture 全为合成标识，未读取/输出凭据或用户正文；策略快照拒绝未知秘密字段 |
| 文档与回退 | 共享合同实现与未来接口明确分开；回退清单已冻结，未进行运行环境回退演练 |

## 5. 证据记录

执行环境：2026-09-16，Windows / Node 20.19.6。盘点开始时 HEAD 为 `6cdbefb`，测试针对其上已有大量未提交变更的工作树；收尾复核时其他操作已将 HEAD 推进到 `25bedf6`，本任务未执行 Git 提交或回滚。共享代码/测试及导出与收尾 HEAD 一致，验收记录仍有本轮补充（不是已发布构建）。不将其他变更计入本阶段实现；日志为本任务工具回执，可复跑命令与 fixture 路径见上述链接。

| 证据 | 命令/范围 | 退出码与结果 |
| --- | --- | --- |
| E1 | `node node_modules/tsx/dist/cli.mjs --test packages/shared/src/collaboration-contracts.spec.ts` | 0；15 通过、0 失败、0 跳过，纯合成数据 |
| E2 | `npm run test -w @agent-cluster/shared` | 0；107 通过、0 失败、0 跳过，包含 E1，不重复累计 |
| E3 | 基线 §6 的 8 文件 server 定向命令：角色、精确命令、语义路由、上下文、逻辑操作、scoped mutation、stop-state、stop-event | 0；40 通过、0 失败、0 跳过；隔离 file/mock，无真实模型/数据库 |
| E4 | `npm run typecheck` | 0；local-runtime-cli、shared、desktop、server、Web 全部通过 |
| E5 | `npm run test:harness` | 0；既有工程规则与新增阶段 0 检查全部通过 |
| E6 | `npm run test:harness:main-agent-phase0` | 0；6 通过、0 失败、0 跳过，包含在 E5，不重复累计 |
| E7 | `npm run build -w @agent-cluster/shared` | 0；类型及 JS 导出构建成功 |

失败先行记录：新模块实现前测试报缺模块（预期）；补充稀疏数组/原型继承策略用例后出现 `Missing expected exception`，修复校验后 E1/E2 全绿。没有通过删用例规避失败。

未执行：完整 server/Web/desktop 全量单测、全应用构建、独立 PostgreSQL 并发/迁移/回退、旧二进制联调、双端 E2E、真实模型及生产部署。本阶段没有修改对应业务代码/存储/UI，采用上述最小有效集合；这些项目在后续阶段仍必须按范围补证。

阶段通过条件：AC 全部有审查/测试证据；状态所有权、迁移与策略快照明确；实现边界没有待裁决冲突。

阶段结论：阶段 0 合同/基线交付完成，具备进入阶段 1 的设计前提；尚未开始阶段 1。普通删除目前仍是物理删除，新主 Agent 讨论与长会话治理没有因导出 helper 而启用。
