# GC-13 权限、失败回退与安全边界 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t13-security-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t13-security-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t13-security-checklist-v1.md)

## 任务目标

对附件、Skill、Agent 和路由边界执行一轮 fail-closed 加固。

## 10–15 分钟执行清单

1. 检查上传、文件读取、Skill 管理、Agent 列表和路由入口。
2. 为跨群聊、无权限、已删除/停用对象补服务端拒绝。
3. 不匹配 Agent 统一回退主 Agent，不扩大授权范围。
4. 检查错误和事件日志不包含文件正文、密钥或存储路径。
5. 增加负向测试并运行定向安全回归。

## 实施状态

已完成（2026-09-22）：完成附件、Skill、Agent、消息路由和历史上下文的服务端 fail-closed 加固；补充跨 Session 附件读取、Agent 上传、Skill 作用域写入、失效 Skill/Agent 执行和成员路由边界的负向测试。

## 完成定义

所有越权路径在服务端被拒绝；失败不会被伪装成成功，也不会因回退而扩大权限范围。
