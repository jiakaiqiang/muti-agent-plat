# TASK-002: 实现 Runtime Registry 服务

## 元信息
- **任务 ID**: TASK-002
- **优先级**: P0
- **预估时间**: 20 分钟
- **依赖**: TASK-001 (Runtime Adapter 接口)
- **所属阶段**: Phase 1 - 可插拔 Runtime 架构

## 背景

### 现有系统已实现
- `RuntimeService` 已维护 `Map<RuntimeType, AgentRuntimeAdapter>`
- `RuntimeService.run(input, signal?)` 已统一记录 runtime invocation
- Runtime 通过 `runtimeType` 字符串选择（在 OrchestratorService 中）
- `RuntimeModule` 提供 Runtime 依赖注入
- 已有 `GenericLLMRuntimeService`、`MockRuntimeService` 等实现
- 但注册逻辑仍硬编码在 `RuntimeService` 构造函数中

### 当前问题
- Runtime 注册逻辑和执行门面耦合，难以单独测试和扩展
- 无法按类别（external/internal）查询 Runtime
- 缺少 Runtime 的动态注册/移除机制
- 新增 Runtime 需要修改 RuntimeModule 配置

### 本任务目标
基于 TASK-001 扩展后的 `AgentRuntimeAdapter`，从 `RuntimeService` 中抽出 `RuntimeRegistryService`，让 `RuntimeService` 保持执行门面职责，Registry 负责注册、查询、分类和健康状态。

## 目标
实现 RuntimeRegistryService，提供：
1. Runtime 注册功能（按 external/internal 分类）
2. Runtime 查询功能（按名称、类别查询）
3. Runtime 健康检查日志
4. Runtime 列表展示

## 范围

### 包含
- 创建 `RuntimeRegistryService`
- 从 `RuntimeService` 迁移现有 adapter map
- 实现按 `RuntimeType` 注册、查询、列表方法
- 支持按 `metadata.category` 分类查询
- 实现注册、查询、列表方法
- 添加日志记录

### 不包含
- Runtime 配置文件加载
- Runtime 自动发现
- Runtime 热加载机制
- 改变 `RuntimeService.run(input, signal?)` 对外行为

## 技术方案

### 文件结构
```
apps/server/src/modules/runtimes/
  ├── runtime-registry.service.ts (新建)
  └── runtime-registry.service.spec.ts (新建)
```

### 核心实现
```typescript
// apps/server/src/modules/runtimes/runtime-registry.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type { AgentRuntimeAdapter, RuntimeAdapterCategory, RuntimeType } from '@agent-cluster/shared';

@Injectable()
export class RuntimeRegistryService {
  private readonly logger = new Logger(RuntimeRegistryService.name);
  private readonly adapters = new Map<RuntimeType, AgentRuntimeAdapter>();
  
  async registerAdapter(adapter: AgentRuntimeAdapter): Promise<void> {
    const { available, reason } = adapter.checkAvailability
      ? await adapter.checkAvailability()
      : { available: true };
    if (!available) {
      this.logger.warn(`Runtime ${adapter.type} unavailable: ${reason}`);
      return;
    }
    this.adapters.set(adapter.type, adapter);
    this.logger.log(`Runtime registered: ${adapter.type}`);
  }
  
  getAdapter(type: RuntimeType): AgentRuntimeAdapter | undefined {
    return this.adapters.get(type);
  }
  
  listByCategory(category: RuntimeAdapterCategory): AgentRuntimeAdapter[] {
    return [...this.adapters.values()].filter(
      (adapter) => adapter.metadata?.category === category
    );
  }
  
  listAll(): AgentRuntimeAdapter[] {
    return [...this.adapters.values()];
  }
  
  unregister(type: RuntimeType): boolean {
    const deleted = this.adapters.delete(type);
    if (deleted) this.logger.log(`Runtime unregistered: ${type}`);
    return deleted;
  }
}
```

### RuntimeService 集成要求

- `RuntimeService` 构造函数负责把现有 `mock/generic_llm/codex/claude_code` 注册进 `RuntimeRegistryService`
- `RuntimeService.run()` 改为通过 `registry.getAdapter(input.agent.runtimeType)` 查找 adapter
- `RuntimeService.recordInvocation()` 和 `unsupportedResult()` 保持原语义不变

## 测试先行（TDD）

1. 先新增 `runtime-registry.service.spec.ts`，覆盖注册、按 `RuntimeType` 查询、按 category 查询、不可用 adapter 不注册、unregister。
2. 先新增/更新 `runtime-routing-smoke` 或最小服务测试，断言 `RuntimeService.run()` 仍能通过 registry 找到 `mock` runtime。
3. 再实现 `RuntimeRegistryService`。
4. 最后重构 `RuntimeService` 使用 registry，并确保原有 runtime routing 行为不变。

## 完成标准

### 功能标准
- [ ] RuntimeRegistryService 类创建完成
- [ ] RuntimeService 继续作为执行门面
- [ ] 实现 registerAdapter 方法（含可用性检查）
- [ ] 实现 getAdapter 方法
- [ ] 实现 listByCategory 方法
- [ ] 实现 listAll 方法
- [ ] 实现 unregister 方法
- [ ] 添加日志记录

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 使用 @Injectable() 装饰器
- [ ] 所有公开方法都有 JSDoc 注释
- [ ] 单元测试覆盖核心方法

## 验证命令

```bash
# 1. TypeScript 编译检查
npm run typecheck

# 2. 运行单元测试
npm --workspace @agent-cluster/server run test -- runtime-registry.service.spec.ts
```

```powershell
# 3. 检查服务是否可注入
Select-String -Path apps/server/src/modules/runtimes/runtime-registry.service.ts -Pattern "@Injectable\\(\\)"

# 4. 检查方法是否完整
Select-String -Path apps/server/src/modules/runtimes/runtime-registry.service.ts -Pattern "registerAdapter|getAdapter|listByCategory|listAll|unregister"
```

## 单元测试用例

```typescript
// runtime-registry.service.spec.ts
describe('RuntimeRegistryService', () => {
  let service: RuntimeRegistryService;
  
  beforeEach(() => {
    service = new RuntimeRegistryService();
  });
  
  it('should register external runtime', async () => {
    const mockAdapter: AgentRuntimeAdapter = {
      type: 'codex',
      metadata: {
        name: 'codex',
        version: '0.1.0',
        category: 'external',
        provider: 'openai',
        capabilityIds: ['cap-file-write']
      },
      checkAvailability: async () => ({ available: true }),
      run: async () => ({} as any),
      cancel: async () => {},
      healthCheck: async () => ({} as any)
    };
    
    await service.registerAdapter(mockAdapter);
    const found = service.getAdapter('codex');
    
    expect(found).toBeDefined();
    expect(found?.name).toBe('codex');
  });
  
  it('should list by category', async () => {
    // 注册一个 external 和一个 internal
    await service.registerAdapter(mockExternalAdapter);
    await service.registerAdapter(mockInternalAdapter);
    
    const externals = service.listByCategory('external');
    const internals = service.listByCategory('internal');
    
    expect(externals.length).toBe(1);
    expect(internals.length).toBe(1);
  });
});
```

## 失败策略

### 如果注册失败
1. 检查 adapter 是否实现 `AgentRuntimeAdapter.run`
2. 确认 checkAvailability 方法正常工作
3. 查看日志确认失败原因

### 如果查询返回 undefined
1. 确认 Runtime 已成功注册
2. 检查名称是否匹配（大小写敏感）
3. 使用 listAll() 查看所有已注册 Runtime

### 如果单元测试失败
1. 确认 mock adapter 符合接口定义
2. 检查异步方法是否正确 await
3. 查看测试输出的具体错误信息

## 风险边界

### 低风险
- 只是内存中的 Map 操作
- 不涉及持久化和外部依赖

### 需要注意
- 注册时需要 await checkAvailability（异步操作）
- 内存中存储，服务重启后需要重新注册
- 同名 Runtime 会被覆盖（需要在文档中说明）

## 交付格式

### 代码文件
- `apps/server/src/modules/runtimes/runtime-registry.service.ts`
- `apps/server/src/modules/runtimes/runtime-registry.service.spec.ts`
- `apps/server/src/modules/runtimes/runtime.service.ts`
- `apps/server/src/modules/runtimes/runtime.module.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过 (5/5)
✓ 服务可注入
✓ 所有方法已实现
```

### 日志示例
```
[RuntimeRegistryService] Runtime registered: codex
[RuntimeRegistryService] Runtime registered: mock
[RuntimeRegistryService] Runtime unavailable: zocode (CLI not found)
```

## 后续任务
- TASK-008: 实现 Runtime 智能路由服务
