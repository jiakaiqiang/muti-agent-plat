# GC-14 端到端验收与追踪矩阵 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t14-acceptance-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t14-acceptance-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t14-acceptance-checklist-v1.md)

## 研究定位

- E2E：`tests/e2e/`。
- Harness：`tests/harness-engineering/`。
- 全局验证：`npm run typecheck`、`npm run test`、`npm run test:harness`、`npm run build`。
- 既有客户端验证：主链路、取消、恢复、Skill 管理和桌面呈现入口。

## 设计决策

- 先用确定性 fake provider 验证协议和状态，再单独标注真实多模态/模型质量。
- 追踪矩阵区分 passed、partial、pending、not-executed。
- 不因文档存在而勾选实现通过。
- 每个失败场景保留最小复现和日志位置。

## 实施步骤

1. 把 GC-01–GC-13 的 AC 汇总到矩阵。
2. 增加 2–3 条关键端到端路径和负向路径。
3. 运行最小验证集合。
4. 记录环境、命令、退出码和证据。
5. 复核未执行外部依赖并明确后续入口。

## 风险

- fake provider 只能证明协议，不证明真实图片理解质量。
- 受限桌面环境失败时必须区分环境阻断与产品失败。
