# 阶段 2A：统一消息意图、需求隔离与完整 Token 预算 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P2A-AC1 | P2A-T1、P2A-T6 | 双端重复提交同一消息只产生一个业务路由；含“不要停止”的普通句子不误判为停止命令。 | 待验证 |
| P2A-AC2 | P2A-T1、P2A-T2、P2A-T6 | 构造多意图语料与“这个也加上/按上次方案/继续”案例，检查目标与动作；无绑定的确认不能批准任意待办。 | 待验证 |
| P2A-AC3 | P2A-T1、P2A-T2、P2A-T3、P2A-T6 | 一千条旧消息/一百个历史需求不被整包注入；用户 @ 质量 Agent 时保留明确目标，非成员走选择/加入确认。 | 待验证 |
| P2A-AC4 | P2A-T2、P2A-T3、P2A-T6 | A 中的私有需求片段不进入 B；独立需求不继承旧约束；含指令的文件/聊天不能扩大工具权限。 | 待验证 |
| P2A-AC5 | P2A-T4、P2A-T6 | 长中文、长 schema、图片/工具返回使完整请求超限时，在发送前触发确定的裁剪/容量拒绝；不能只检查 L3。 | 待验证 |
| P2A-AC6 | P2A-T5、P2A-T6 | 并发专家不可各自花完整剩余额度；重启/重试不重置累计预算；预算耗尽进入主 Agent 可解释的等待状态。 | 待验证 |
| P2A-AC7 | P2A-T3、P2A-T4、P2A-T6 | 最小必要证据仍超容量时不发送残缺请求，不宣称完成；相同补读要求去重，有限重试后给出原因。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts
npm run test:e2e:token-budget
npm run test -w @agent-cluster/shared
```

相关既有测试：

- [deterministic-command-guard.service.spec.ts](../../apps/server/src/modules/intent-recognition/deterministic-command-guard.service.spec.ts)
- [command-application.service.spec.ts](../../apps/server/src/modules/message-routing/command-application.service.spec.ts)

## 3. 必须补充的测试

- [ ] 最终 adapter 请求及每轮工具循环 Token 守卫测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 独立 PostgreSQL 预算并发预留/结算测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 主 Agent 消息意图标注 fixture 回归（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：精确命令零语义调用、目标与 @ 保留、完整请求预算和累计并发预算用例通过；上下文不会随无关历史线性增长。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
