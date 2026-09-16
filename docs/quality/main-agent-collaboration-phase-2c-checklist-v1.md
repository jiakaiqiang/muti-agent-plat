# 阶段 2C：分层缓存、失效治理与成本观测 — Checklist v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 2A、2B 通过；所有缓存必须服从阶段 1 生命周期。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2c-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2c-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2c-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2c-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P2C-AC1 | P2C-T1、P2C-T2、P2C-T4、P2C-T6 | 命中上下文包后仍进行发送前预算检查；高命中但输入超窗时仍拒绝，不通过缓存绕过 2A。 | 待验证 |
| P2C-AC2 | P2C-T1、P2C-T3、P2C-T6 | 同 Agent 的 A/B 会话不得交换内容；删除后到达的回填被拒绝；恢复后旧 generation 缓存不复用。 | 待验证 |
| P2C-AC3 | P2C-T2、P2C-T3、P2C-T6 | 修改相关文件只使依赖它的分析失效；无关进度事件不改变稳定上下文指纹。 | 待验证 |
| P2C-AC4 | P2C-T3、P2C-T6 | 百个相同请求仅一个有效构建提交；缓存宕机不会发起无限摘要或绕过调用总预算。 | 待验证 |
| P2C-AC5 | P2C-T1、P2C-T4、P2C-T6 | 不支持缓存的模型正常执行并标注 unsupported；请求已配置但无回执用量时标记 unknown，不假定命中。 | 待验证 |
| P2C-AC6 | P2C-T1、P2C-T5、P2C-T6 | 不同 usage fixture 映射正确，缺失字段为 unknown；实际金额缺价格版本时不可伪造为零。 | 待验证 |
| P2C-AC7 | P2C-T1、P2C-T2、P2C-T6 | 超容量/过期后正确回源；用户历史与决策仍在；安全/控制类动作不命中旧回答。 | 待验证 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/server
npm run test -w @agent-cluster/local-runtime-cli
npm run typecheck
```

相关既有测试：

- [build-envelope-from-context-assembly.spec.ts](../../apps/server/src/modules/context-v2/build-envelope-from-context-assembly.spec.ts)
- [workspace-metrics.spec.ts](../../apps/server/src/common/workspace-metrics.spec.ts)

## 3. 必须补充的测试

- [ ] 缓存依赖失效、跨进程 single-flight 和迟到回填测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 多 provider 缓存用量归一化 golden fixture（待新增；不能用现有冒烟脚本代替）。
- [ ] 有界缓存容量与回源成本测试（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：失效/隔离/并发/容量测试通过；成本可解释，未知值不伪装为零；缓存不可绕过预算或真实执行。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。
