---
artifact: design_plan
stage: design
producedBy: architect
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: task-acceptance-timeout-reliability-v1
intentContractRef: task-acceptance-timeout-reliability-v1
createdAt: 2026-09-21
---

# 群聊工作流接单超时可靠性 Plan v1

上游规格：[`../product/task-acceptance-timeout-reliability-spec-v1.md`](../product/task-acceptance-timeout-reliability-spec-v1.md)

## 1. 现状根因

`operationPolicy()` 将 `user_message_routing` 和 `task_acceptance` 统一视为 control，并直接返回 120000ms；因此 `PHASE_TIMEOUT_TASK_ACCEPTANCE_MS` 不会生效。实际失败调用在截止前已执行 Glob/Read，但没有机会返回结构化接单结果。

同时，规则接单前有两个独立条件：显式工作流 preflight 和 grounded evidence gate。缺少 L3 可验证文件证据时，保持模型回退是安全行为，不能通过删除 gate 来掩盖问题。

## 2. 设计

### 2.1 阶段预算解析

`operationPolicy` 使用以下顺序：

```text
合法 PHASE_TIMEOUT_<PHASE>_MS
  -> 该配置
无配置/零/非法 task_acceptance
  -> 300000ms
无配置/零/非法其他长阶段
  -> 1200000ms
```

控制阶段的最大尝试次数保持 2；阶段 deadline 仍受 parent deadline 限制。

### 2.2 接单路径

```text
resolveTaskClaim
  -> resolve InvocationPlan
  -> evaluate grounded evidence
  -> explicit preflight
       ├─ 满足：rule accepted，不启动模型
       └─ 不满足：model task_acceptance，注入稳定 fallback reason codes
  -> existing output validation / state transition
```

不变项：权限、pending approval、依赖、任务内容和 Agent 匹配仍是规则接单门槛；evidence gate 继续 fail closed。

### 2.3 诊断

扩展 preflight 为纯函数诊断结果，返回稳定码，例如 `EVIDENCE_GATE:evidence-empty`、`DEPENDENCIES_NOT_READY`、`PENDING_APPROVAL`。这些码只进入 Runtime context 的系统规则和测试证据，不进入用户正文或事件正文。

## 3. 允许与禁止修改范围

允许：`apps/server/src/modules/runtimes/logical-operation-store.ts`、`apps/server/src/common/runtime-config.ts`、`apps/server/src/modules/orchestrator/task-acceptance-preflight.ts`、对应单测、`.env.example`、本四件套。

禁止：Runtime Output Schema、WorkflowRun 状态机、停止/返工状态、前端布局、真实供应商配置和生产数据。

## 4. 兼容性与回退

历史持久化逻辑操作读取旧记录不需要迁移。新配置缺失时使用 300 秒默认值；如果现场需要回退，可显式设置 `PHASE_TIMEOUT_TASK_ACCEPTANCE_MS=120000`，不需要代码回退。任何阶段超时仍按既有 `RUNTIME_TIMEOUT`/`phase_timeout` 合同处理。

## 5. 验证顺序

1. 先补配置解析、操作策略和 preflight 诊断单测。
2. 再补 orchestrator 回归：证据齐全时不调用模型，证据缺失时保留模型回退及原因。
3. 运行 server typecheck、server tests、workflow managed execution E2E、Harness 检查和 diff check。

## 6. 实施回填（2026-09-21）

- `LogicalOperationStore.operationPolicy` 已改为优先使用合法阶段配置；`task_acceptance` 未配置时使用 300000ms 有限默认值。
- preflight 增加稳定 reason codes；orchestrator 保留 evidence gate，并将回退原因写入受控 Runtime system rule，不进入用户消息。
- 没有修改 Runtime Output、WorkflowRun、停止或返工语义。
- 真实 Claude/本地 Runtime 慢调用未在本轮重新执行，仍需上线前按现场配置观察。
