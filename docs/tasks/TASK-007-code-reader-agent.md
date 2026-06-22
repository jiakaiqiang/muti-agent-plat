# TASK-007: 实现 CodeReader Runtime Adapter (基于工具注册表)

## 元信息
- **任务 ID**: TASK-007
- **优先级**: P0
- **预估时间**: 30 分钟
- **依赖**: TASK-004 (Tool Registry), TASK-005 (FileReader Tool), TASK-006 (映射表)
- **所属阶段**: Phase 1 - 内部 Runtime 实现

## 背景

### 现有系统已实现
- `apps/server/src/modules/runtimes/generic-llm-runtime.service.ts` — 通用 LLM Runtime
- `WorkspaceToolsService` — 文件读取功能
- Agent 注册表在 `packages/shared/src/default-agent-presets.ts`
- RuntimeModule 已有依赖注入基础设施

### 当前问题
- 许多简单代码读取/摘要任务不需要外部 LLM
- 缺少本地自主执行的内部 Runtime
- 简单的代码读取任务也需要调用 LLM（成本高、速度慢）
- 无法在离线环境使用

### 本任务目标
实现第一个内部 Runtime Adapter（`code_reader`），基于工具注册表提供本地代码读取和轻量分析能力。它是 Runtime，不是产品 Agent；现有 Agent 可通过 `runtimeType` 或路由策略选择它。

## 目标
实现 CodeReaderRuntimeAdapter，提供本地代码读取和分析能力，无需依赖外部服务。

## 范围

### 包含
- 创建 `CodeReaderRuntimeAdapterService` 类
- 扩展 `RuntimeType`、runtime config/label，使 `code_reader` 成为可编译、可识别的内部 Runtime
- 实现/复用 `AgentRuntimeAdapter`
- 通过工具注册表调用工具
- 返回 `AgentRunResult` / `RuntimeOutput`
- 注册到 `RuntimeRegistryService`

### 不包含
- 代码编辑功能
- LLM 增强（本阶段纯工具调用）

## 技术方案

```typescript
// apps/server/src/modules/runtimes/code-reader-runtime-adapter.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter, RuntimeType } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { getToolsForCapabilities } from '../tools/capability-tool-mapping';

@Injectable()
export class CodeReaderRuntimeAdapterService implements AgentRuntimeAdapter {
  private readonly logger = new Logger(CodeReaderRuntimeAdapterService.name);
  
  readonly type: RuntimeType = 'code_reader';
  readonly metadata = {
    name: 'code-reader',
    version: '0.1.0',
    category: 'internal' as const,
    provider: 'self-hosted',
    capabilityIds: ['cap-file-read', 'cap-code-search']
  };
  
  constructor(private toolRegistry: ToolRegistryService) {
  }
  
  async checkAvailability() {
    return { available: true };
  }
  
  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    const { taskContext, workingDirectory } = input.contextPack;
    
    try {
      const toolNames = getToolsForCapabilities(this.metadata.capabilityIds);
      this.logger.log(`Available tools: ${toolNames.join(', ')}`);
      
      const targetFiles = this.identifyTargetFiles(taskContext);
      const readFileTool = this.toolRegistry.getTool('read_file');
      if (!readFileTool) {
        throw new Error('read_file tool not found');
      }
      
      const fileContents = await Promise.all(
        targetFiles.map(file =>
          readFileTool.execute(
            { path: file },
            { workingDirectory: workingDirectory?.path ?? '', sessionId: input.sessionId, signal }
          )
        )
      );
      
      // 4. 生成分析结果
      const analysis = this.analyzeFiles(fileContents);
      
      return this.completed(input, analysis);
    } catch (error) {
      return this.failed(input, error);
    }
  }
  
  private identifyTargetFiles(taskContext: any): string[] {
    return taskContext.targetFiles || 
           taskContext.workspaceFocus?.relevantFiles || 
           [];
  }
  
  private analyzeFiles(fileContents: any[]): any {
    return {
      summary: `Analyzed ${fileContents.length} files`,
      files: fileContents
        .filter(fc => fc.success)
        .map(fc => ({
          path: fc.output.path,
          lineCount: fc.output.lineCount,
          size: fc.output.content.length
        }))
    };
  }
}
```

> 注意：本任务不得使用 `as any` 绕过 `RuntimeType`。实现前先把 `code_reader` 同步加入 shared contract、runtime labels、runtime config 和相关 e2e/smoke 覆盖，再实现 adapter。

## 测试先行（TDD）

1. 先新增 `code-reader-runtime-adapter.service.spec.ts`。
2. 测试 metadata：`category=internal`、`provider=self-hosted`、包含 `cap-file-read`。
3. 测试成功读取：mock `ToolRegistryService.getTool('read_file')` 返回工具，断言 `run()` 输出 `AgentRunResult.status=completed`。
4. 测试工具缺失：断言返回 `failed` 且写入 `runtime_failed` 事件。
5. 先新增/更新 `runtime-routing-smoke` 覆盖 `code_reader` 可被识别和路由。
6. 测试失败后再实现 adapter。

## 完成标准

### 功能标准
- [ ] CodeReaderRuntimeAdapterService 类创建完成
- [ ] `code_reader` 已加入 `RuntimeType`、runtime config/label，且没有对 `RuntimeType` 使用 `as any`
- [ ] 实现 `AgentRuntimeAdapter`
- [ ] 通过 ToolRegistry 调用工具
- [ ] 正确处理成功和失败情况
- [ ] 返回 `AgentRunResult`
- [ ] 不新增产品 Agent 类体系

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 使用 @Injectable() 装饰器
- [ ] 添加日志记录
- [ ] 单元测试覆盖

## 验证命令

```bash
# 1. TypeScript 编译
npm run typecheck

# 2. 单元测试
npm --workspace @agent-cluster/server run test -- code-reader-runtime-adapter.service.spec.ts

# 3. 集成测试
node tests/e2e/runtime-routing-smoke.mjs
```

## 单元测试用例

```typescript
describe('CodeReaderRuntimeAdapterService', () => {
  let runtime: CodeReaderRuntimeAdapterService;
  let mockToolRegistry: jest.Mocked<ToolRegistryService>;
  
  beforeEach(() => {
    mockToolRegistry = {
      getTool: jest.fn()
    } as any;
    runtime = new CodeReaderRuntimeAdapterService(mockToolRegistry);
  });
  
  it('should have correct metadata', () => {
    expect(runtime.metadata.name).toBe('code-reader');
    expect(runtime.metadata.category).toBe('internal');
    expect(runtime.metadata.capabilityIds).toContain('cap-file-read');
  });
  
  it('should execute file reading', async () => {
    const mockReadFileTool = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        output: { path: 'test.ts', content: 'code', lineCount: 10 }
      })
    };
    mockToolRegistry.getTool.mockReturnValue(mockReadFileTool as any);
    
    const result = await runtime.run({
      sessionId: 'test',
      contextPack: {
        workingDirectory: '/tmp',
        taskContext: { targetFiles: ['test.ts'] }
      }
    } as any);
    
    expect(result.status).toBe('completed');
    expect(mockReadFileTool.execute).toHaveBeenCalled();
  });
  
  it('should handle tool not found', async () => {
    mockToolRegistry.getTool.mockReturnValue(undefined);
    
    const result = await runtime.run({
      sessionId: 'test',
      contextPack: { workingDirectory: '/tmp', taskContext: {} }
    } as any);
    
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('tool not found');
  });
});
```

## 失败策略

### 如果工具调用失败
- 检查工具是否已注册到 ToolRegistry
- 确认工具名称是否正确
- 查看工具执行的错误信息

### 如果文件读取失败
- 检查文件路径是否正确
- 确认工作目录设置正确
- 查看文件权限

### 如果测试失败
- 确认 mock 对象配置正确
- 检查异步调用是否正确 await
- 查看测试输出详情

## 风险边界

### 低风险
- 只读操作，不修改文件
- 本地执行，无网络依赖
- 有错误处理

### 需要注意
- 大文件读取性能
- 并发读取文件数量限制
- 内存占用（多文件场景）

## 交付格式

### 代码文件
- `apps/server/src/modules/runtimes/code-reader-runtime-adapter.service.ts`
- `apps/server/src/modules/runtimes/code-reader-runtime-adapter.service.spec.ts`
- `packages/shared/src/contracts.ts`
- `apps/server/src/common/runtime-config.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过 (3/3)
✓ Runtime 可注入
✓ 工具调用成功
```

### 使用示例
```typescript
// 注册 Runtime
const runtime = new CodeReaderRuntimeAdapterService(toolRegistry);
await runtimeRegistry.registerAdapter(runtime);

// 调用 Agent
const result = await runtime.run({
  sessionId: 'session-1',
  contextPack: {
    workingDirectory: '/project',
    taskContext: {
      targetFiles: ['src/index.ts', 'src/utils.ts']
    }
  }
});

console.log(result.output);
// {
//   summary: "Analyzed 2 files",
//   files: [
//     { path: "src/index.ts", lineCount: 50, size: 1200 },
//     { path: "src/utils.ts", lineCount: 30, size: 800 }
//   ]
// }
```

## 后续任务
- TASK-008: 实现 Runtime 智能路由服务
- TASK-012: 实现 TestRunner 工具
