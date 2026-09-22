# GC-14 端到端验收与追踪矩阵 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t14-acceptance-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t14-acceptance-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t14-acceptance-task-v1.md)

## 端到端场景

| 场景 | 证据 | 状态 |
| --- | --- | --- |
| 图片/文件上传、缩略图/文件 Tag、失败重试和删除 | `apps/web/src/components/UserInputBoxComposer.spec.ts`；`apps/server/src/modules/attachments/attachments.service.spec.ts` | passed |
| 图片识别摘要、识别失败保留原图并可重试 | `attachments.service.spec.ts`：image understanding、recognition failure/retry | passed |
| 只发送附件、附件自动上下文挂载 | `UserInputBoxComposer.spec.ts`：attachment-only draft/context event；`sessions.service.spec.ts` | passed |
| `/Skill` 分类选择、单 Skill 限制、普通 `/` 文本 | `UserInputBoxComposer.spec.ts`；`skills.service.spec.ts` | passed |
| `@Agent` 搜索、多选、群外加入确认、主 Agent 隐藏 | `UserInputBoxComposer.spec.ts`；`agent-surface-catalog.spec.ts`；`agents.service.spec.ts` | passed |
| 显式 Agent 路由、候选不匹配回退主 Agent、无 `@` 分发 | `tag-routing.spec.ts`；`test:e2e:multi-agent-discussion` | passed |
| 协同面板阶段输出和历史展示 | `CollaborationTaskBoard.vue`；`test:e2e:main-chain`；根级 Web 测试 | passed |
| Agent 单独重试、手动重新汇总追加版本 | `sessions.service.spec.ts`：collaboration retry/re-summarize；`orchestrator.service.spec.ts` | passed |
| 权限越界、删除附件、停用对象、历史访问和 Session 删除 | GC-13 安全定向回归；`test:e2e:security`；`test:e2e:session-delete` | passed |
| 协同取消、崩溃恢复和显式继续 | `test:e2e:cancel`；`test:e2e:recovery` | passed |
| Skill 注入到 Agent Runtime 身份 | `test:e2e:skill-injection`（显式 system_admin 身份头） | passed |
| Session Agent 隔离与协调路由专项夹具 | `test:e2e:session-agent-isolation`、`test:e2e:coordinator-controlled-routing` | passed：隔离夹具允许受信任内部 Coordinator 事件；协调路由夹具覆盖工作流任务创建、拒绝、阻塞和显式替代确认 |

## 全局验证

- [x] `npm run typecheck`：所有 workspace 通过。
- [x] `npm run test`：通过；Server 1701 项（1684 通过、17 跳过、0 失败），Web 350 项（350 通过），开发监督 37 项（37 通过），桌面 13 项（13 通过）。
- [x] `npm run test:harness`：Phase 1–5、v2-only、运行时位置、工作流视图和主 Agent Phase 0/6 全部通过；Phase 3 100/100、Phase 4 50/50。
- [x] `npm run build`：workspace 构建通过；仅有 Rollup 注释和包体积提示。

## 追踪矩阵

| AC/任务 | 代表实现/测试入口 | 状态 |
| --- | --- | --- |
| GC-01 | `packages/shared/src/group-chat-contracts.spec.ts`；消息/附件结构化合同 | passed |
| GC-02 | `UserInputBoxComposer.spec.ts`：Tag、草稿、附件-only、键盘交互 | passed |
| GC-03 | `attachments.service.spec.ts`：限制、失败重试、持久化、生命周期 | passed |
| GC-04 | `attachments.service.spec.ts`：图片理解和识别失败重试 | passed |
| GC-05 | `attachments.service.spec.ts`：按需读取、跨 Session 拒绝；`attachment-reader.tool.spec.ts` | passed |
| GC-06 | `skills.service.spec.ts`、`skill-registry.spec.ts`、`test:e2e:skill-injection` | passed |
| GC-07 | `UserInputBoxComposer.spec.ts`：分类 Skill picker、单 Skill 约束 | passed |
| GC-08 | `UserInputBoxComposer.spec.ts`、`agent-surface-catalog.spec.ts`、Agent service tests | passed |
| GC-09 | `tag-routing.spec.ts`、`orchestrator.service.spec.ts`、`test:e2e:multi-agent-discussion` | passed |
| GC-10 | `CollaborationTaskBoard.vue`、Web component tests、`test:e2e:main-chain` | passed |
| GC-11 | `sessions.service.spec.ts`、`orchestrator.service.spec.ts`、`test:e2e:cancel`/`recovery` | passed |
| GC-12 | `sessions.service.spec.ts`、`attachments.service.spec.ts`、`test:e2e:session-delete` | passed |
| GC-13 | GC-13 checklist 的 149/149 安全回归、195/195 编排/Session 回归、`test:e2e:security` | passed |
| GC-14 | 本矩阵、全局门禁和代表性 E2E | passed（真实模型、外部 PostgreSQL 和 Windows 原生缩放仍保持 pending） |

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 工作树 | Windows，PowerShell；file persistence；mock Runtime；无真实付费模型和外部通知 |
| E2E 通过 | `main-chain`、`multi-agent-discussion`、`cancel`、`recovery`、`session-delete`、`security`、`skill-injection`、`session-agent-isolation`、`coordinator-controlled-routing` |
| 未执行 | 真实多模态/付费模型、PostgreSQL 外部实例、Windows 原生缩放 |
| 失败/跳过 | 全局测试无失败；Server 保留 17 项既有 skip，原因由各测试记录维护 |

## 验收结论

- [x] GC14-AC1：GC-01–GC-13 均关联实现、测试和证据。
- [x] GC14-AC2：正向、负向、失败重试、取消、恢复和删除生命周期均有结果。
- [x] GC14-AC3：未执行外部依赖明确标记 pending；两条专项夹具已在 mock/file persistence 环境通过，没有伪造通过。
- [x] GC14-AC4：Web/桌面复用共享合同；Harness v2-only 校验通过。
- [x] GC14-AC5：typecheck、test、test:harness、build 及代表性 E2E 已执行并记录。
