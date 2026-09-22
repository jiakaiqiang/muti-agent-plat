# GC-13 权限、失败回退与安全边界 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t13-security-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t13-security-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t13-security-checklist-v1.md)

## 研究定位

- Agent/Skill 权限：`apps/server/src/modules/agents/`、`apps/server/src/modules/skills/`。
- 文件工具和 Context：`apps/server/src/modules/context-v2/`、workspaces/tool authority。
- 统一错误和运行时守卫：`apps/server/src/common/`、orchestrator/runtime routing。

## 设计决策

- 服务端权限是最终事实，前端过滤只用于体验。
- 路由失败回退到主 Agent，不自动搜索用户无权使用的 Agent。
- 附件错误返回稳定错误码和 ID，不回传原始正文。
- 失败状态必须在状态机中显式，禁止以空结果代表成功。

## 实施步骤

1. 列出 GC-03/06/08/09 的权限入口。
2. 补齐跨群聊、越权写入和失效引用守卫。
3. 统一回退和错误码。
4. 增加负向安全测试和日志脱敏检查。

## 风险

- 权限守卫分散时容易只修 UI；必须至少有服务端测试。
- 回退主 Agent 不代表可以读取用户无权访问的附件。
