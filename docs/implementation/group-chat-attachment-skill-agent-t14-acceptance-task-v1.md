# GC-14 端到端验收与追踪矩阵 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t14-acceptance-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t14-acceptance-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t14-acceptance-checklist-v1.md)

## 任务目标

把 13 个实现切片串成最小端到端验证，并输出可审计的追踪矩阵。

## 10–15 分钟执行清单

1. 建立需求 AC → GC Task → 测试入口映射表。
2. 编写或串接一条“上传图片 + Skill + 多 Agent + 主 Agent 汇总”路径。
3. 编写一条失败重试/重新汇总路径。
4. 编写一条权限/删除负向路径。
5. 运行最小 typecheck/test/harness/build 入口或记录阻断。
6. 输出 passed/partial/pending 结果，不夸大证据。

## 完成定义

需求文档、四件套任务文档、实现、测试和证据可以互相追溯；真实模型或外部服务未执行时明确标记。

## 执行状态（2026-09-22）

- 已建立 GC-01–GC-14 追踪矩阵，关联实现、单元测试、代表性 E2E 和全局门禁。
- 已修复并记录两处 Harness 合同漂移：`ContextAssembly.attachmentRefs` 和 `tool.attachment_read`。
- 已修正 Skill 注入、Session Agent 隔离和协调路由 E2E 夹具，使其遵守 GC-13 的显式身份头和 chat surface 边界。
- 全局 typecheck、build、test、test:harness 的既有基线通过；本轮聚焦验证补充通过 `workflow-runtime.service.spec.ts`（32/32）、`test:e2e:session-agent-isolation` 和 `test:e2e:coordinator-controlled-routing`。真实模型、外部 PostgreSQL、Windows 原生缩放仍保持 pending。
