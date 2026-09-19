# 阶段 4：主 Agent 文档、精确确认与所选工作流交接 — Tasks v1

> 日期：2026-09-16
> 状态：已实现并于 2026-09-19 通过用户验收；顺延缺口见阶段 5 Tasks 承接说明。
> 依赖：阶段 3 通过，复用 1 与 2A～2C 的隔离、预算、记忆和缓存。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-4-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-4-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-4-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-4-checklist-v1.md)

## 执行规则

- 所有任务初始为待实施；先确认前置阶段退出条件，不跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 本轮只生成文档；以下路径与改动是后续开发范围，不是已完成修改。

## 任务清单

### P4-T1 实现正式文档版本聚合

- [x] 完成实现与审查（2026-09-19）：shared 合同 7/7、store 8/8、orchestrator 发布路径、PG V15 之前的 V14 表 + 跨实例唯一。
- 前置：阶段 3 通过，复用 1 与 2A～2C 的隔离、预算、记忆和缓存。
- 交付：复用 brief/artifact，保存来源、hash、状态和不可变正文，统一主 Agent 发布入口。
- 覆盖：P4-AC1、P4-AC2。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P4-T2 实现精确确认事务

- [x] 完成实现与审查（2026-09-19）：确认绑定卡片版本（documentId/Revision/contentHash/fingerprint），过期拒绝回传当前版本，重放幂等；两张阶段 3 卡片路由接入。
- 前置：P4-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：确认关联需求/文档版本，旧卡拒绝、重复幂等、修订失效与共享投影。
- 覆盖：P4-AC2、P4-AC3。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 承接自阶段 3（2026-09-19 验收时决定）：`confirm_member_addition`（approve 后把成员加入
  `participatingAgentIds` 并为其补 `user_mention`/`coordinator` 委派；decline 关闭卡片）与
  `discussion_clarification`（answer_in_chat 走阶段 3 的 @/补充路径；proceed_anyway 以现有综合
  进入文档发布）两张卡的选项处理，均以主 Agent 持有的 confirmationId 为准、旧卡拒绝、重复幂等。
  同时决定 `MAIN_AGENT_DISCUSSION_ENABLED` 的默认值（阶段 3 验收时保持默认关）。

### P4-T3 接入只读流程选择与映射

- [x] 完成实现与审查（2026-09-19）：`workflow-member-mapping` 4/4；缺成员改为 `capability_mapping_required` + 映射卡（锁 definitionHash），不再静默扩员；`start()` 校验 hash。
- 前置：P4-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：确认后选择已发布版本，检查角色与能力，缺口由主 Agent 请求用户处理。
- 覆盖：P4-AC4、P4-AC5。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P4-T4 实现启动握手与持久化派发

- [x] 完成实现与审查（2026-09-19）：启动合同 6/6、start store 11/11（提交/派发分离、崩溃 reclaim 不分叉）、PG V15 跨实例一请求一行。
- 前置：P4-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：绑定输入快照、唯一启动键、事务 outbox、worker 幂等领取与崩溃恢复。
- 覆盖：P4-AC3、P4-AC5、P4-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P4-T5 接入双端文档 Diff 和返工沟通

- [x] 完成实现与审查（2026-09-19）：shared 投影 11/11，web 内联 diff 5/5，desktop 并排 diff 6/6（复用既有 historyDiffModel）；返工改为按图边回溯，无合法边则显式等待。
- 前置：P4-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：复用既有 Diff/历史，保持各端样式；质量拒绝显示返工或可处理的阻塞。
- 覆盖：P4-AC2、P4-AC4、P4-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 承接自阶段 3（2026-09-19 验收时决定）：讨论计划（`plannedTargets`）、委派进度（带
  `delegationId` 的状态事件）、综合（`messageKind:'summary'` + `sourceDelegationIds`）与两张确认卡
  的双端专用呈现；阶段 3 只复用既有事件类型，两端按通用样式渲染。另：合同已定义 `blocked` 委派
  状态但无写入方（专家"缺证"目前落 failed），是否映射由本阶段一并决定。

### P4-T6 验证版本竞争和完整交接

- [x] 完成实现与审查（2026-09-19）：E2E `npm run test:e2e:requirement-document-handoff` 通过；隔离 PostgreSQL 14/14（含 V15 新集合）；四门禁全绿。
- 前置：P4-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：双端旧卡/重复点击、流程下架、能力缺失、启动崩溃及质量拒绝矩阵。
- 覆盖：P4-AC1、P4-AC2、P4-AC3、P4-AC4、P4-AC5、P4-AC6、P4-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

## 完成定义

当前文档确认后按用户所选流程唯一启动，过期/重复操作安全；Diff、成员映射和质量返工可追溯。

完成一个任务不等于阶段完成；所有 AC 必须有证据。最后同步相关合同、测试说明与 Checklist，不修改其他未通过阶段的状态。
