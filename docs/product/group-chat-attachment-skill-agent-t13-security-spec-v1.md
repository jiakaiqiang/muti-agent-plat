# GC-13 权限、失败回退与安全边界 Spec v1

> 任务：GC-13 | 预计：10–15 分钟 | 前置：GC-03、GC-06、GC-08、GC-09
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t13-security-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t13-security-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t13-security-checklist-v1.md)

## 目标

把上传、Skill、Agent、文件读取和路由回退的权限边界集中验证，确保失败时 fail-closed。

## 必须保证

- Agent 不能调用人类用户上传入口。
- 附件 ID 不能跨群聊读取。
- 个人/群聊/系统 Skill 写权限严格分离。
- `@Agent` 列表只返回当前用户有权使用的可用 Agent。
- 指定 Agent 不匹配时回退主 Agent，不扩大到未授权 Agent。
- 历史展示不能绕过当前执行权限。
- 已删除附件、停用 Skill、删除 Agent 均不能被新任务直接执行。

## 验收标准

- `GC13-AC1`：关键接口全部有权限守卫。
- `GC13-AC2`：跨群聊和越权读取 fail-closed。
- `GC13-AC3`：路由回退不越权扩展候选。
- `GC13-AC4`：错误信息不泄露文件正文或敏感配置。
- `GC13-AC5`：失败状态不能伪装成功。
