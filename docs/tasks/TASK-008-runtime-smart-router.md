# TASK-008: 实现 Runtime 智能路由服务

## 元信息
- **任务 ID**: TASK-008
- **优先级**: P0
- **预估时间**: 20 分钟
- **依赖**: TASK-002 (Runtime Registry)
- **所属阶段**: Phase 1 - 智能路由

## 背景

### 现有系统已实现
- `OrchestratorService` 中通过 `engineeringRuntimeType` 选择 Runtime
- `ContextRouterService` 根据上下文路由到不同 Agent
- RuntimeModule 提供 Runtime 依赖注入
- 但选择逻辑硬编码在 OrchestratorService 中

### 当前问题
- Runtime 选择逻辑分散在多个服务
- Runtime 不可用时缺少基于健康状态/能力的显式降级策略
- 不区分内部 Runtime 和第三方 Runtime
- 无法优先使用成本低的 Runtime

### 本任务目标
实现 RuntimeSmartRouterService，并接入现有 `selectEngineeringRuntime`/`RuntimeService` 链路，根据能力需求、健康状态和配置选择最优 Runtime。降级必须产生可审计原因，不能静默绕过用户指定的 runtime override。

## 目标
实现 RuntimeSmartRouterService，根据能力需求和健康状态自动选择最优 Runtime。

## 范围

### 包含
- 创建 `RuntimeSmartRouterService`
- 实现智能路由逻辑（三级降级）
- 实现健康检查
- 接入现有 runtime selection，不破坏 `EngineeringRuntimeSelection.source`
- 添加降级日志

### 不包含
- 负载均衡
- 成本优化算法
- 复杂的选择策略

## 技术方案

```typescript
// apps/server/src/modules/runtimes/runtime-smart-router.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RuntimeRegistryService } from './runtime-registry.service';
import type { AgentRuntimeAdapter, RuntimeType } from '@agent-cluster/shared';

@Injectable()
export class RuntimeSmartRouterService {
  private readonly logger = new Logger(RuntimeSmartRouterService.name);
  
  constructor(private registry: RuntimeRegistryService) {}
  
  /**
   * 智能选择 Runtime
   * 优先级：internal (内部) > external (第三方) > generic_llm (兜底)
   */
  async selectRuntime(
    requiredCapabilityIds: string[],
    options?: {
      preferredRuntimeType?: RuntimeType;
      preferInternal?: boolean;
      excludeRuntimeTypes?: RuntimeType[];
      allowFallback?: boolean;
    }
  ): Promise<{ adapter: AgentRuntimeAdapter; reason: string; fallbackUsed: boolean }> {
    this.logger.log(
      `Selecting runtime for capabilities: ${requiredCapabilityIds.join(', ')}`
    );

    // 0. 用户/项目/Agent 明确指定的 runtime 优先；不可用时只有 allowFallback=true 才降级。
    if (options?.preferredRuntimeType) {
      const preferred = this.registry.getAdapter(options.preferredRuntimeType);
      if (preferred && await this.isHealthy(preferred)) {
        return { adapter: preferred, reason: 'preferred runtime is healthy', fallbackUsed: false };
      }
      if (options?.allowFallback === false) {
        throw new Error(`Preferred runtime unavailable: ${options.preferredRuntimeType}`);
      }
    }
    
    // 1. 优先选择内部 Runtime (成本低、隐私安全、速度快)
    if (options?.preferInternal !== false) {
      const internalRuntime = await this.selectFromCategory(
        'internal',
        requiredCapabilityIds,
        options?.excludeRuntimeTypes
      );
      
      if (internalRuntime) {
        this.logger.log(`Selected internal runtime: ${internalRuntime.type}`);
        return { adapter: internalRuntime, reason: 'selected healthy internal runtime', fallbackUsed: true };
      }
    }
    
    // 2. 降级到第三方 Runtime
    const externalRuntime = await this.selectFromCategory(
      'external',
      requiredCapabilityIds,
      options?.excludeRuntimeTypes
    );
    
    if (externalRuntime) {
      this.logger.warn(
        `Falling back to external runtime: ${externalRuntime.type} ` +
        `(internal unavailable)`
      );
      return { adapter: externalRuntime, reason: 'fallback to healthy external runtime', fallbackUsed: true };
    }
    
    // 3. 最终降级到 Generic LLM (兜底)
    this.logger.error(
      'No suitable runtime found, falling back to generic_llm'
    );
    const genericLLM = this.registry.getAdapter('generic_llm');
    
    if (!genericLLM) {
      throw new Error('No runtime available, including generic_llm fallback');
    }
    
    return { adapter: genericLLM, reason: 'fallback to generic_llm', fallbackUsed: true };
  }
  
  /**
   * 从指定类别中选择 Runtime
   */
  private async selectFromCategory(
    category: 'external' | 'internal',
    requiredCapabilityIds: string[],
    excludeRuntimeTypes?: RuntimeType[]
  ): Promise<AgentRuntimeAdapter | null> {
    const candidates = this.registry
      .listByCategory(category)
      .filter(rt => {
        // 排除指定的 Runtime
        if (excludeRuntimeTypes?.includes(rt.type)) {
          return false;
        }
        
        // 检查是否支持所有必需能力
        return requiredCapabilityIds.every(capabilityId =>
          rt.metadata?.capabilityIds.includes(capabilityId)
        );
      });
    
    // 按优先级检查健康状态
    for (const candidate of candidates) {
      const isHealthy = await this.isHealthy(candidate);
      if (isHealthy) {
        return candidate;
      }
    }
    
    return null;
  }
  
  /**
   * 检查 Runtime 是否健康
   */
  private async isHealthy(runtime: AgentRuntimeAdapter): Promise<boolean> {
    try {
      const health = runtime.healthCheck ? await runtime.healthCheck() : { status: 'healthy' };
      return health.status === 'healthy';
    } catch (error) {
      this.logger.warn(
        `Health check failed for ${runtime.name}: ${error.message}`
      );
      return false;
    }
  }
}
```

## 测试先行（TDD）

1. 先新增 `runtime-smart-router.service.spec.ts`。
2. 测试明确指定 runtime 健康时不降级。
3. 测试明确指定 runtime 不健康且 `allowFallback=false` 时抛错。
4. 测试 internal 健康时优先 internal。
5. 测试 internal 不可用时 fallback 到 external。
6. 测试没有匹配能力时 fallback 到 `generic_llm`。
7. 测试返回值包含 `reason` 和 `fallbackUsed`，供事件审计。
8. 再实现服务，并最后接入现有 selection 链路。

## 完成标准

### 功能标准
- [ ] RuntimeSmartRouterService 类创建完成
- [ ] 实现 selectRuntime 方法（三级降级）
- [ ] 实现 selectFromCategory 私有方法
- [ ] 实现 isHealthy 健康检查
- [ ] 显式 runtime override 不被静默覆盖
- [ ] 返回选择原因和 fallback 标记
- [ ] 添加详细日志（选择/降级/失败）
- [ ] 支持排除特定 Runtime

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 使用 @Injectable() 装饰器
- [ ] 异步方法正确处理
- [ ] 单元测试覆盖

## 验证命令

```bash
# 1. TypeScript 编译
npm run typecheck

# 2. 单元测试
npm --workspace @agent-cluster/server run test -- runtime-smart-router.service.spec.ts

# 3. 集成测试
node tests/e2e/engineering-runtime-selection-smoke.mjs
```

## 单元测试用例

```typescript
describe('RuntimeSmartRouterService', () => {
  let service: RuntimeSmartRouterService;
  let mockRegistry: jest.Mocked<RuntimeRegistryService>;
  
  beforeEach(() => {
    mockRegistry = {
      listByCategory: jest.fn(),
      getAdapter: jest.fn()
    } as any;
    service = new RuntimeSmartRouterService(mockRegistry);
  });
  
  it('should select internal runtime first', async () => {
    const mockInternal = createMockRuntime({
      name: 'code-reader',
      category: 'internal',
      metadata: { capabilityIds: ['cap-file-read'], category: 'internal' }
    });
    
    mockRegistry.listByCategory.mockReturnValue([mockInternal]);
    
    const selected = await service.selectRuntime(['cap-file-read']);
    
    expect(selected.adapter.metadata.name).toBe('code-reader');
    expect(selected.adapter.metadata.category).toBe('internal');
  });
  
  it('should fallback to external when internal unavailable', async () => {
    const mockExternal = createMockRuntime({
      name: 'codex',
      category: 'external',
      metadata: { capabilityIds: ['cap-file-write'], category: 'external' }
    });
    
    mockRegistry.listByCategory
      .mockReturnValueOnce([])  // internal: empty
      .mockReturnValueOnce([mockExternal]); // external: codex
    
    const selected = await service.selectRuntime(['cap-file-write']);
    
    expect(selected.adapter.metadata.name).toBe('codex');
    expect(selected.adapter.metadata.category).toBe('external');
  });
  
  it('should fallback to generic_llm when no runtime available', async () => {
    const mockGeneric = createMockRuntime({ name: 'generic_llm' });
    
    mockRegistry.listByCategory.mockReturnValue([]);
    mockRegistry.getAdapter.mockReturnValue(mockGeneric);
    
    const selected = await service.selectRuntime(['unknown_capability']);
    
    expect(selected.adapter.type).toBe('generic_llm');
  });
  
  it('should skip unhealthy runtime', async () => {
    const unhealthyRuntime = createMockRuntime({
      name: 'unhealthy',
      metadata: { capabilityIds: ['cap-file-read'], category: 'internal' }
    });
    unhealthyRuntime.healthCheck.mockResolvedValue({
      status: 'unhealthy'
    } as any);
    
    const healthyRuntime = createMockRuntime({
      name: 'healthy',
      metadata: { capabilityIds: ['cap-file-read'], category: 'internal' }
    });
    
    mockRegistry.listByCategory.mockReturnValue([
      unhealthyRuntime,
      healthyRuntime
    ]);
    
    const selected = await service.selectRuntime(['cap-file-read']);
    
    expect(selected.adapter.metadata.name).toBe('healthy');
  });
});
```

## 失败策略

### 如果没有合适的 Runtime
- 检查能力需求是否合理
- 确认 Runtime 已正确注册
- 查看日志了解降级过程

### 如果健康检查失败
- 检查 Runtime 的 healthCheck 实现
- 确认 Runtime 真实可用性
- 查看具体错误信息

### 如果测试失败
- 确认 mock 返回值正确
- 检查异步调用是否正确 await
- 查看测试日志

## 风险边界

### 低风险
- 选择逻辑清晰
- 有兜底机制（generic_llm）

### 需要注意
- 健康检查可能超时
- 降级可能导致能力不足
- 日志要清楚记录降级原因

## 交付格式

### 代码文件
- `apps/server/src/modules/runtimes/runtime-smart-router.service.ts`
- `apps/server/src/modules/runtimes/runtime-smart-router.service.spec.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过 (4/4)
✓ 智能路由生效
✓ 降级逻辑正确
```

### 日志示例
```
[RuntimeSmartRouterService] Selecting runtime for capabilities: cap-file-read
[RuntimeSmartRouterService] Selected internal runtime: code-reader
```

```
[RuntimeSmartRouterService] Selecting runtime for capabilities: cap-file-write
[RuntimeSmartRouterService] Falling back to external runtime: codex (internal unavailable)
```

```
[RuntimeSmartRouterService] No suitable runtime found, falling back to generic_llm
```

## 后续任务
- TASK-009: 集成路由服务到 OrchestratorService
- TASK-010: 实现 Runtime 配置文件加载
