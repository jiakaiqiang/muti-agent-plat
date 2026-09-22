# GC-06 Skill 注册中心与分层治理 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t06-skill-registry-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t06-skill-registry-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t06-skill-registry-task-v1.md)

## 自动验证

- [x] 系统、群聊、个人三个 scope 可读写。
- [x] 同名 Skill 的覆盖顺序为个人 > 群聊 > 系统。
- [x] 每个 Skill 只能有一个分类，且分类必须属于同一 scope。
- [x] 有 Skill 的分类不能直接删除，必须先迁移。
- [x] 个人 Skill 可无审批升级群聊级。
- [x] 停用 Skill 不出现在可用列表，历史引用保留。

## 权限验证

- [x] 普通用户不能修改系统级 Skill。
- [x] 非群聊管理员不能修改群聊级 Skill。
- [x] 用户可以维护自己的个人级 Skill。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/shared`; `npm run typecheck -w @agent-cluster/server`; `npm run typecheck -w @project/web`; `node --import tsx --test apps/server/src/modules/skills/skill-registry.spec.ts`; `node ../../node_modules/tsx/dist/cli.mjs --test --test-force-exit src/modules/skills/skills.service.spec.ts`（cwd `apps/server`）；`npm run test -w @agent-cluster/server`; `npm run test -w @project/web -- src/components/SkillManager.spec.ts src/components/agent-management-v2-only.spec.ts`; `npm run test -w @project/web` |
| 结果 | shared/server/web 类型检查通过；纯合并规则 2/2；Skill service 7/7；Server 全量 1665 通过、17 跳过、0 失败，开发服务器 7/7；Web Skill/Agent 定向 11/11；Web 全量 66 文件、341 测试通过。 |
| 失败/跳过原因 | 直接从仓库根目录运行带 Nest 参数装饰器的 service spec 会因 tsx 未读取 server tsconfig 而失败，改为从 `apps/server` 使用其 tsconfig 重跑通过；Server 17 个 skip 为既有测试。 |
