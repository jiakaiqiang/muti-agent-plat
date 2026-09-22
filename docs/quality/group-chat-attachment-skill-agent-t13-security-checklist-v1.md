# GC-13 权限、失败回退与安全边界 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t13-security-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t13-security-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t13-security-task-v1.md)

## 负向验证

- [x] Agent 调用上传接口被拒绝。
- [x] 跨 Session/群聊读取附件被拒绝。
- [x] 非管理员修改系统/群聊 Skill 被拒绝；控制器无身份头不再隐式授予 system_admin。
- [x] 无权限或失效 Agent 不出现在对应 surface 列表，且不能通过 ID 直接路由；持久成员消失时不扩展到全量 Agent 目录。
- [x] 已删除附件、停用/删除 Skill、停用/删除 Agent 不能被新消息或旧任务重新执行。
- [x] 指定候选不匹配时只回退到主 Agent。

## 脱敏验证

- [x] 事件和错误不包含文件正文；附件仅持久化元数据引用，读取按 Session 和稳定 ID 校验。
- [x] 错误不包含密钥、存储路径或内部凭据；上传失败返回稳定状态/错误码，服务端错误不回传原始附件内容。
- [x] failed/unknown 不被记录为成功；识别失败、运行失败和不可执行目标均保持显式失败状态。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/server`; `npx tsx --test --test-force-exit --tsconfig tsconfig.json src/modules/skills/skills.service.spec.ts src/modules/agents/agents.service.spec.ts src/modules/attachments/attachments.service.spec.ts src/modules/message-routing/tag-routing.spec.ts src/modules/sessions/sessions.service.spec.ts`; `npx tsx --test --test-force-exit --tsconfig tsconfig.json src/modules/orchestrator/orchestrator.service.spec.ts src/modules/sessions/sessions.service.spec.ts` |
| 结果 | typecheck 通过；安全定向测试 149/149 通过；编排/Session 回归 195/195 通过；服务端全量测试 1701 项（1684 通过、17 跳过、0 失败），开发门禁 7/7。 |
| 失败/跳过原因 | 无。 |
