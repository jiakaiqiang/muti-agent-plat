# TASK-001: 定义 Runtime Adapter 统一接口

## 元信息
- **任务 ID**: TASK-001
- **优先级**: P0
- **预估时间**: 15 分钟
- **依赖**: 无
- **所属阶段**: Phase 1 - 可插拔 Runtime 架构

## 背景

### 现有系统已实现
- `apps/server/src/modules/runtimes/generic-llm-runtime.service.ts` — 已有 Generic LLM Runtime
- `apps/server/src/modules/runtimes/mock-runtime.service.ts` — 已有 Mock Runtime
- `apps/server/src/modules/runtimes/runtime.module.ts` — Runtime 模块定义
- Runtime 通过 `runtimeType` 字符串选择（如 'generic_llm'、'mock'）

- `packages/shared/src/contracts.ts` 已定义 `AgentRuntimeAdapter`、`AgentRunInput`、`AgentRunResult`
- `apps/server/src/modules/runtimes/runtime.service.ts` 已通过 `Map<RuntimeType, AgentRuntimeAdapter>` 统一调用 `run(input, signal?)`
- `codex`、`claude_code`、`generic_llm`、`mock` 适配器已实现同一 `run` 入口

### 当前问题
- 现有 `AgentRuntimeAdapter` 只有 `type/run/stream?/cancel?`，缺少元信息、可用性和健康检查合同
- Runtime 注册仍写在 `RuntimeService` 构造函数里，新增 Runtime 需要修改服务代码
- 第三方 Runtime 和内部 Runtime 无法统一管理
- 健康检查、可用性判断逻辑不一致

### 本任务目标
在不破坏现有 `AgentRuntimeAdapter.run(input, signal?)` 调用方式的前提下，扩展 Runtime Adapter 合同，为后续 Registry、健康检查和智能路由奠定基础。

## 目标
扩展现有 `AgentRuntimeAdapter` 统一接口，包含：
1. Runtime 元信息（name、version、category、provider、capabilities）
2. 可用性检查方法
3. 兼容现有执行入口 `run(input, signal?)`
4. 取消执行方法
5. 健康检查方法

## 范围

### 包含
- 修改 `packages/shared/src/contracts.ts` 中的 `AgentRuntimeAdapter`
- 新增相关类型（`RuntimeAdapterMetadata`、`RuntimeAvailability`、`RuntimeHealthStatus`）
- 保持 `AgentRunInput`、`AgentRunResult`、`run(input, signal?)` 不变
- 添加 JSDoc 注释

### 不包含
- 具体 Runtime 的实现
- Registry 服务
- 配置文件

## 技术方案

### 文件结构
```
packages/shared/src/contracts.ts (修改)
```

### 接口定义
```typescript
// packages/shared/src/contracts.ts
export type RuntimeAdapterCategory = 'external' | 'internal';

export type RuntimeAdapterMetadata = {
  readonly name: string;
  readonly version: string;
  readonly category: RuntimeAdapterCategory;
  readonly provider: string;
  readonly capabilityIds: UUID[];
};

export type RuntimeAvailability = {
  available: boolean;
  reason?: string;
};

export type RuntimeHealthStatus = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  lastCheckAt: ISODateTime;
  message?: string;
};

export type AgentRuntimeAdapter = {
  type: RuntimeType;
  metadata?: RuntimeAdapterMetadata;
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult>;
  stream?: (runId: UUID) => AsyncIterable<AgentRuntimeEvent>;
  cancel?: (runId: UUID) => Promise<void>;
  checkAvailability?: () => Promise<RuntimeAvailability>;
  healthCheck?: () => Promise<RuntimeHealthStatus>;
};
```

> 注意：不要新增 `RuntimeAdapter`、`AgentRunInput` 或 `RuntimeResult` 第二套类型，避免和 shared contract 分裂。

## 测试先行（TDD）

1. 先新增或更新类型兼容性测试/编译检查：确保现有 `MockRuntimeService`、`GenericLlmRuntimeService`、`CodexRuntimeAdapterService`、`ClaudeCodeRuntimeAdapterService` 仍满足 `AgentRuntimeAdapter`。
2. 先运行 `npm run typecheck`，确认当前基线。
3. 修改 shared contract 后再次运行 `npm run typecheck`。
4. 若新增必填字段导致现有 adapter 大面积失败，回退为可选字段，本任务只建立兼容合同，不强制所有 Runtime 立即补齐元信息。

## 完成标准

### 功能标准
- [ ] `AgentRuntimeAdapter` 合同扩展完成
- [ ] 不新增第二套 `AgentRunInput` / `RuntimeResult`
- [ ] 保持 `run(input, signal?)` 兼容
- [ ] 包含元信息、可用性检查、健康检查类型
- [ ] category 支持 'external' | 'internal' 枚举
- [ ] RuntimeHealthStatus 类型定义完成
- [ ] 所有接口都有 JSDoc 注释

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 接口符合 ESLint 规则
- [ ] 导出所有公开类型

## 验证命令

```bash
# 1. TypeScript 编译检查
npm run typecheck
```

```powershell
# 2. 检查 shared contract 是否扩展现有接口
Select-String -Path packages/shared/src/contracts.ts -Pattern "export type AgentRuntimeAdapter"
Select-String -Path packages/shared/src/contracts.ts -Pattern "RuntimeAdapterMetadata|RuntimeHealthStatus|RuntimeAvailability"
```

## 失败策略

### 如果 TypeScript 编译失败
1. 检查类型定义是否完整
2. 确认所有引用的类型都已导入
3. 查看编译错误信息，逐个修复

### 如果接口设计不合理
1. 参考现有 `packages/shared/src/contracts.ts` 的 `AgentRuntimeAdapter`
2. 参考 `apps/server/src/modules/runtimes/runtime.service.ts` 的调用方式
3. 保持向后兼容，新增能力优先设计为可选字段/方法

## 风险边界

### 低风险
- 只是 shared contract 扩展，不涉及具体 Runtime 行为
- 不影响现有代码运行

### 需要注意
- 接口设计要考虑前向兼容性
- category 枚举要足够灵活
- 方法签名要考虑异步执行场景

## 交付格式

### 代码文件
- `packages/shared/src/contracts.ts`

### 文档
- 在文件顶部添加接口说明注释
- 每个方法添加 JSDoc 注释，说明用途和参数

### 验证输出
```bash
# 执行验证命令后，应看到：
✓ TypeScript 编译通过
✓ 文件已创建
✓ 接口导出正确
```

## 后续任务
- TASK-002: 实现 Runtime Registry 服务
- TASK-003: 定义 Tool 接口和类型
