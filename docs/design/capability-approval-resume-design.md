# 能力审批中断恢复机制设计文档

## 1. 背景

### 当前问题

用户报告：任务执行时因能力审批被阻断（`CAPABILITY_BLOCKED`），用户授权后无法从中断处恢复，而是从头开始执行。

### 期望行为

用户授权后，任务应该**从审批中断处继续执行**，而不是重新开始。

---

## 2. 现状分析

### 2.1 已有基础设施 ✅

1. **状态枚举**：`RuntimeInvocationStatus` 包含 `'pending_approval'`
2. **数据结构**：`InvocationPlan` 有 `pendingApprovals?: PendingApprovalInfo[]`
3. **检测逻辑**：`InvocationResolver.resolve()` 已区分审批阻断和硬阻断
4. **结果构造**：`orchestrator.pendingApprovalResult()` 返回 `pending_approval` 状态
5. **错误标记**：`HUMAN_APPROVAL_REQUIRED` 错误码标记为 `retryable: true`

### 2.2 缺失组件 ❌

1. **状态持久化**：`pending_approval` 结果未保存 `InvocationPlan` 和上下文
2. **恢复触发器**：用户审批后无机制触发任务重试
3. **事件通知**：前端无法感知审批请求和审批完成
4. **API 接口**：缺少 `retryPendingApprovalTask` 端点

---

## 3. 技术设计

### 3.1 架构概览

```
┌─────────────┐
│   用户操作   │
│  (审批授权)  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                     Capabilities API                         │
│  POST /capabilities/{capabilityId}/approve                   │
│  { sessionId, agentId } → 记录审批                            │
└──────┬──────────────────────────────────────────────────────┘
       │
       ▼ (触发事件)
┌─────────────────────────────────────────────────────────────┐
│                   Events Service                             │
│  发送 'capability_approved' 事件                             │
└──────┬──────────────────────────────────────────────────────┘
       │
       ▼ (触发重试)
┌─────────────────────────────────────────────────────────────┐
│                 Sessions Service                             │
│  retryPendingApprovalTask(sessionId, taskId)                 │
│  → 读取保存的 pendingInvocation                               │
│  → 重新调用 orchestrator.runAgent()                          │
└──────┬──────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│               Orchestrator Service                           │
│  检查 pendingApprovals → 现在为空 → 继续执行                  │
│  (InvocationPlan 被复用,上下文保持)                           │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 数据流

#### 阶段 1: 任务执行遇到审批阻断

```typescript
// orchestrator.runAgent()
const plan = invocationResolver.resolve({...});
// plan.pendingApprovals = [{toolId, toolKey, approvalId, reasons}]

if (plan.pendingApprovals && plan.pendingApprovals.length > 0) {
  // 保存中断状态
  const pendingInvocation = {
    invocationId: plan.invocationId,
    sessionId: plan.sessionId,
    taskId: plan.taskId!,
    agentId: plan.agent.agentId,
    phase: plan.phase,
    plan: plan,  // 完整的 InvocationPlan
    input: input, // RunAgentInput
    pendingApprovals: plan.pendingApprovals,
    createdAt: new Date().toISOString()
  };
  
  // 存储到 session
  this.sessions.savePendingInvocation(plan.sessionId, pendingInvocation);
  
  // 发送审批请求事件
  this.events.create({
    sessionId: plan.sessionId,
    type: 'capability_approval_required',
    taskId: plan.taskId,
    fromAgentId: plan.agent.agentId,
    content: approvalMessage,
    metadata: {
      renderAs: 'confirmation_card',
      payload: { pendingApprovals: plan.pendingApprovals }
    }
  });
  
  return pendingApprovalResult(plan, plan.pendingApprovals);
}
```

#### 阶段 2: 用户授权

```typescript
// capabilities.controller.ts
@Post(':capabilityId/approve')
async approve(
  @Param('capabilityId') capabilityId: string,
  @Body() body: { sessionId: string; agentId: string }
) {
  const result = this.capabilities.approve(capabilityId, {
    sessionId: body.sessionId,
    agentId: body.agentId
  });
  
  // 发送审批完成事件
  this.events.create({
    sessionId: body.sessionId,
    type: 'capability_approved',
    content: `能力 ${result.capability.name} 已授权`,
    metadata: {
      renderAs: 'system_notice',
      payload: { capabilityId, approvalKey: result.approvalKey }
    }
  });
  
  // 触发任务恢复
  await this.sessions.retryPendingApprovalTasks(body.sessionId, capabilityId);
  
  return result;
}
```

#### 阶段 3: 任务恢复执行

```typescript
// sessions.service.ts
async retryPendingApprovalTasks(sessionId: string, capabilityId: string) {
  const session = this.get(sessionId);
  if (!session.pendingInvocations) return;
  
  // 查找需要此 capability 的待审批调用
  const toRetry = session.pendingInvocations.filter(inv =>
    inv.pendingApprovals.some(a => a.toolId === capabilityId)
  );
  
  for (const inv of toRetry) {
    // 重新检查:可能需要多个审批
    const stillPending = inv.pendingApprovals.filter(a => {
      const check = this.capabilities.checkInvocation(a.toolId, {
        sessionId: inv.sessionId,
        agentId: inv.agentId
      });
      return !check.allowed;
    });
    
    if (stillPending.length > 0) {
      // 仍有未授权的能力,更新状态但不重试
      inv.pendingApprovals = stillPending;
      continue;
    }
    
    // 所有审批完成,触发重试
    this.logger.log(`Retrying task ${inv.taskId} after approval`);
    
    // 从 pendingInvocations 移除
    session.pendingInvocations = session.pendingInvocations.filter(
      i => i.invocationId !== inv.invocationId
    );
    
    // 重新执行,复用原始 input
    await this.orchestrator.runAgent(inv.input);
  }
}
```

### 3.3 关键数据结构

#### PendingInvocation (新增)

```typescript
// packages/shared/src/contracts.ts

export type PendingInvocation = {
  invocationId: UUID;
  sessionId: UUID;
  taskId: UUID;
  agentId: UUID;
  phase: AgentRunPhase;
  plan: InvocationPlan;  // 完整的 InvocationPlan
  input: RunAgentInput;  // 原始输入
  pendingApprovals: PendingApprovalInfo[];
  createdAt: ISODateTime;
};

// SessionDetail 增加字段
export type SessionDetail = {
  // ... 现有字段
  pendingInvocations?: PendingInvocation[];
};
```

---

## 4. 实现步骤

### Step 1: 扩展类型定义

**文件**: `packages/shared/src/contracts.ts`

- [x] 添加 `PendingInvocation` 类型
- [x] `SessionDetail` 增加 `pendingInvocations?: PendingInvocation[]`
- [x] `CollaborationEventType` 已有 `capability_approval_required` 和 `capability_approved`

### Step 2: 修改 Orchestrator 保存中断状态

**文件**: `apps/server/src/modules/orchestrator/orchestrator.service.ts`

修改 `pendingApprovalResult()` 方法:

```typescript
private pendingApprovalResult(
  plan: InvocationPlan,
  pendingApprovals: NonNullable<InvocationPlan['pendingApprovals']>,
  input: RunAgentInput  // 新增参数
): AgentRunResult {
  // 保存中断状态
  const pendingInvocation: PendingInvocation = {
    invocationId: plan.invocationId,
    sessionId: plan.sessionId,
    taskId: plan.taskId!,
    agentId: plan.agent.agentId,
    phase: plan.phase,
    plan,
    input,
    pendingApprovals,
    createdAt: new Date().toISOString()
  };
  
  this.sessions.savePendingInvocation(plan.sessionId, pendingInvocation);
  
  // 发送审批请求事件
  this.events.create({
    sessionId: plan.sessionId,
    type: 'capability_approval_required',
    taskId: plan.taskId,
    fromAgentId: plan.agent.agentId,
    toAgentIds: [],
    content: approvalMessage,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'confirmation_card',
      payload: { pendingApprovals }
    },
    createdAt: new Date().toISOString()
  });
  
  // 返回 pending_approval 结果
  return { /* 现有逻辑 */ };
}
```

调用处修改:

```typescript
// orchestrator.service.ts:5228
if (plan.pendingApprovals && plan.pendingApprovals.length > 0) {
  return this.pendingApprovalResult(plan, plan.pendingApprovals, input);  // 传入 input
}
```

### Step 3: Sessions Service 增加恢复逻辑

**文件**: `apps/server/src/modules/sessions/sessions.service.ts`

```typescript
savePendingInvocation(sessionId: string, invocation: PendingInvocation) {
  const session = this.get(sessionId);
  if (!session.pendingInvocations) {
    session.pendingInvocations = [];
  }
  session.pendingInvocations.push(invocation);
  this.persist();
}

async retryPendingApprovalTasks(sessionId: string, approvedCapabilityId: string) {
  const session = this.get(sessionId);
  if (!session.pendingInvocations || session.pendingInvocations.length === 0) {
    return;
  }
  
  const toRetry = session.pendingInvocations.filter(inv =>
    inv.pendingApprovals.some(a => a.toolId === approvedCapabilityId)
  );
  
  for (const inv of toRetry) {
    // 重新检查所有待审批能力
    const stillPending = inv.pendingApprovals.filter(a => {
      const check = this.capabilities.checkInvocation(a.toolId, {
        sessionId: inv.sessionId,
        agentId: inv.agentId
      });
      return !check.allowed;
    });
    
    if (stillPending.length > 0) {
      // 仍有未授权的能力
      inv.pendingApprovals = stillPending;
      this.persist();
      continue;
    }
    
    // 所有审批完成,移除并重试
    session.pendingInvocations = session.pendingInvocations.filter(
      i => i.invocationId !== inv.invocationId
    );
    this.persist();
    
    this.logger.log(`[Session ${sessionId}] Retrying task ${inv.taskId} after capability approval`);
    
    // 异步重试,不阻塞当前响应
    setImmediate(() => {
      this.orchestrator.runAgent(inv.input).catch(err => {
        this.logger.error(`[Session ${sessionId}] Retry failed:`, err);
      });
    });
  }
}
```

### Step 4: Capabilities Controller 触发恢复

**文件**: `apps/server/src/modules/capabilities/capabilities.controller.ts`

```typescript
@Post(':capabilityId/approve')
async approve(
  @Param('capabilityId') capabilityId: string,
  @Body() body: CapabilityInvocationCheck
) {
  const result = this.capabilities.approve(capabilityId, body);
  
  // 发送审批完成事件
  this.events.create({
    sessionId: body.sessionId,
    type: 'capability_approved',
    fromAgentId: body.agentId,
    toAgentIds: [],
    content: `能力 ${result.capability.name} 已授权`,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: {
        capabilityId,
        capabilityKey: result.capability.key,
        approvalKey: result.approvalKey
      }
    },
    createdAt: new Date().toISOString()
  });
  
  // 触发任务恢复
  await this.sessions.retryPendingApprovalTasks(body.sessionId, capabilityId);
  
  return result;
}
```

### Step 5: 前端集成

**文件**: `apps/dashboard/src/components/CapabilityApprovalCard.vue` (新增)

```vue
<template>
  <div class="approval-card">
    <h3>需要授权能力</h3>
    <ul>
      <li v-for="approval in pendingApprovals" :key="approval.approvalId">
        <strong>{{ approval.toolKey }}</strong>
        <span>原因: {{ approval.reasons.join(', ') }}</span>
      </li>
    </ul>
    <button @click="approveAll" :disabled="approving">
      {{ approving ? '授权中...' : '授权所有能力' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { apiClient } from '@/api/client';

const props = defineProps<{
  sessionId: string;
  agentId: string;
  pendingApprovals: Array<{
    toolId: string;
    toolKey: string;
    approvalId: string;
    reasons: string[];
  }>;
}>();

const approving = ref(false);

async function approveAll() {
  approving.value = true;
  try {
    for (const approval of props.pendingApprovals) {
      await apiClient.post(`/capabilities/${approval.toolId}/approve`, {
        sessionId: props.sessionId,
        agentId: props.agentId
      });
    }
  } catch (error) {
    console.error('Approval failed:', error);
  } finally {
    approving.value = false;
  }
}
</script>
```

---

## 5. 测试验证

### 5.1 单元测试

```typescript
// orchestrator.service.spec.ts
describe('capability approval resume', () => {
  it('should save pending invocation when approval required', async () => {
    const result = await service.runAgent({
      phase: 'task_execution',
      // ... task requires file_write
    });
    
    expect(result.status).toBe('pending_approval');
    expect(result.error?.code).toBe('HUMAN_APPROVAL_REQUIRED');
    
    const session = sessions.get(sessionId);
    expect(session.pendingInvocations).toHaveLength(1);
    expect(session.pendingInvocations[0].pendingApprovals).toContainEqual(
      expect.objectContaining({ toolKey: 'tool.file_write' })
    );
  });
  
  it('should resume task after approval', async () => {
    // 1. 触发审批阻断
    const result1 = await service.runAgent({ /* ... */ });
    expect(result1.status).toBe('pending_approval');
    
    // 2. 用户授权
    await capabilities.approve('cap-file-write', { sessionId, agentId });
    
    // 3. 验证任务自动重试
    await waitFor(() => {
      const session = sessions.get(sessionId);
      expect(session.pendingInvocations).toHaveLength(0);
    });
    
    // 4. 验证任务最终完成
    const events = eventsService.list(sessionId);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'runtime_completed' })
    );
  });
});
```

### 5.2 集成测试流程

1. 创建 session,设置 `REQUIRE_USER_CONFIRMATION=true`
2. 分配需要高风险能力的任务 (如文件写入)
3. 验证返回 `pending_approval` 状态
4. 验证前端收到 `capability_approval_required` 事件
5. 调用审批 API
6. 验证前端收到 `capability_approved` 事件
7. 验证任务自动恢复并完成

---

## 6. 风险与限制

### 6.1 风险

1. **状态过期**：长时间未审批的 invocation 可能因上下文变化失效
   - **缓解**: 增加过期时间 (如 1 小时),超时自动清理
   
2. **并发审批**：多个任务同时请求同一能力
   - **缓解**: 审批是会话级的,一次授权惠及所有任务

3. **循环依赖**：任务 A 等审批,任务 B 被 A 阻塞
   - **缓解**: 审批粒度是 capability,不是 task

### 6.2 限制

1. **Generic LLM Runtime**：无状态,恢复时重新生成可能不一致
   - **说明**: 这是预期行为,用户需理解

2. **复杂工具链**：一个任务需要多个审批
   - **处理**: 支持批量审批 UI

---

## 7. 未来优化

1. **智能审批**：根据任务风险自动批量授权低风险操作
2. **审批预热**：任务开始前预测所需能力,提前请求
3. **审批策略**：支持"本次授权"和"永久授权"
4. **审批日志**：记录所有审批决策,供审计

---

## 8. 结论

通过引入 `PendingInvocation` 状态持久化和审批后自动重试机制,系统可以实现真正的"中断-恢复"工作流,而不是简单的重新执行。

**核心设计原则**:
- ✅ 最小侵入:复用现有 `InvocationPlan` 和 `RunAgentInput`
- ✅ 状态透明:前端通过事件感知审批状态
- ✅ 自动恢复:用户授权后自动触发,无需手动重试
- ✅ 向后兼容:不影响现有非审批流程
