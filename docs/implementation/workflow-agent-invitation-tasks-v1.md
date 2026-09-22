# 工作流缺少 Agent 时的证据化邀请与拒绝引导 - Tasks v1

> 状态：核心实现及 Web/桌面生产 renderer 双客户端验收已完成；T5/T6 仅保留原生 Electron 进程环境验收项。依据：[Spec](../product/workflow-agent-invitation-spec-v1.md) | [Plan](../design/workflow-agent-invitation-plan-v1.md) | [Checklist](../quality/workflow-agent-invitation-checklist-v1.md)

## 实施顺序

- [x] **WAI-T1 冻结合同与失败用例**（AC1/2/3/5）：确认卡新增工作流、版本、原选择、Brief/generation 及节点证据字段；覆盖 Agent 节点、机器人审核节点、多节点同 Agent、不可用 Agent 和缺失字段。未声称模型验证需求匹配。
- [x] **WAI-T2 后端邀请与拒绝闭环**（AC1/3/4/6/7）：完成绑定与持久化、待决卡去重、决定幂等、全缺口复核、过期拒绝、批准后原选择唯一继续路径；拒绝保持等待流程选择。
- [x] **WAI-T3 Web 处理与展示**（AC2/3/4/5）：事件投影、证据卡、真实决定接口、拒绝导航和防止旧选择弹窗重开均已接线。
- [x] **WAI-T4 桌面只读处理与展示**（AC2/3/4/5/6）：桌面独立 UI、真实回执、只读流程目录和受控 Web 管理入口已完成；正式构建通过。
- [ ] **WAI-T5 竞争、恢复与回归**（AC3/5/6/7）：file、隔离 PostgreSQL、服务端竞争/版本/需求/Agent/Session 安全边界已通过；专项 E2E 已以真实 HTTP/SSE 同时驱动 Web 与桌面生产 renderer，覆盖冲突决定、失败端同步、拒绝后重新发布选择卡、选择器显式打开、SSE 重连、刷新、重选和唯一启动。仅原生 Electron 进程在页面加载前受 Chromium/GPU 环境崩溃阻塞，故本任务暂不勾选。
- [ ] **WAI-T6 交付验收与文档同步**（AC1～7）：合同、实现、测试命令、结果、截图和环境失败证据已同步；因 T5 的原生 Electron 质量门未完成，专项不能标记为最终全部通过。

## 顺序与交接

T1 -> T2 -> T3/T4 -> T5 -> T6。新增共享模块须导出并重建 `@agent-cluster/shared`；后端新事件字段同时验证 file/PostgreSQL 重启重建；前端不能以本地 resolved 事件假装后端接受。任何任务失败时保持未勾选，不因文档完成或旧阶段通过而标绿。

## 预期验证命令（实施后执行）

```powershell
npm run typecheck
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/server
npm run test -w @project/web
npm run test:desktop
npm run test:e2e:requirement-document-handoff
npm run test:e2e:workflow-agent-invitation
npm run test:e2e:client-presentation
npm run test:e2e:desktop-render
npm run test:harness
```

需增补本专项的端到端入口，覆盖 Web/桌面拒绝与批准的实际 HTTP 回执、跨端恢复和只启动一次；不能用旧 `requirement-document-handoff` 的“仅出现映射卡”断言代替闭环验收。真实模型、生产部署与业务数据库操作不属于本专项验证。
