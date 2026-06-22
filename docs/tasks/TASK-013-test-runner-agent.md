# TASK-013: 实现 TestRunner Runtime Adapter

## 元信息
- **任务 ID**: TASK-013
- **优先级**: P1
- **预估时间**: 30 分钟
- **依赖**: TASK-007 (CodeReader Runtime Adapter), TASK-012 (TestRunner Tool)
- **所属阶段**: Phase 1 - 内部 Runtime 实现

## 背景

### 现有系统已实现
- CodeReader Runtime Adapter 已实现（基于工具注册表）
- TestRunner Tool 已实现
- `AgentRuntimeAdapter` 合同已扩展
- 工具注册表基础设施已完成

### 当前问题
- 无法自动运行测试验证代码改动
- 测试执行依赖手动命令
- Runtime 无法把测试结果转换为统一 `AgentRunResult`

### 本任务目标
实现 TestRunnerRuntimeAdapter，提供测试执行和结果分析能力，作为第二个内部 Runtime Adapter。产品里的测试 Agent 仍是协作角色，可通过 runtime selection 选择该 Runtime。

## 范围

### 包含
- 创建 `TestRunnerRuntimeAdapterService` 类
- 扩展 `RuntimeType`、runtime config/label，使 `test_runner` 成为可编译、可识别的内部 Runtime
- 实现 `AgentRuntimeAdapter`
- 通过工具注册表调用 `run_test` 工具
- 解析测试结果
- 返回 `AgentRunResult` 和 `test_report` artifact

### 不包含
- 测试生成
- 测试修复
- 覆盖率详细分析

## 技术方案

```typescript
// apps/server/src/modules/runtimes/test-runner-runtime-adapter.service.ts
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter, RuntimeType } from '@agent-cluster/shared';

@Injectable()
export class TestRunnerRuntimeAdapterService implements AgentRuntimeAdapter {
  private readonly logger = new Logger(TestRunnerRuntimeAdapterService.name);
  
  readonly type: RuntimeType = 'test_runner';
  readonly metadata = {
    name: 'test-runner',
    version: '0.1.0',
    category: 'internal' as const,
    provider: 'self-hosted',
    capabilityIds: ['cap-test-report', 'cap-command-run']
  };
  
  constructor(private toolRegistry: ToolRegistryService) {
  }
  
  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    const { taskContext, workingDirectory } = input.contextPack;
    
    try {
      // 1. 获取 run_test 工具
      const runTestTool = this.toolRegistry.getTool('run_test');
      if (!runTestTool) {
        throw new Error('run_test tool not found');
      }
      
      // 2. 执行测试
      const testPattern = taskContext.testPattern;
      const result = await runTestTool.execute(
        { script: taskContext.testScript ?? 'test' },
        { workingDirectory: workingDirectory?.path ?? '', sessionId: input.sessionId, agentId: input.agent.id, signal }
      );
      
      if (!result.success) {
        return this.failed(input, result.error || 'Test execution failed');
      }
      
      // 3. 生成测试报告
      const report = this.generateReport(result.output);
      
      this.logger.log(
        `Tests completed: ${report.passed}/${report.total} passed`
      );
      
      return this.completed(input, report);
    } catch (error) {
      return this.failed(input, error);
    }
  }
  
  private generateReport(testOutput: any) {
    return {
      script: testOutput.script,
      duration: testOutput.duration,
      total: testOutput.summary.total,
      passed: testOutput.summary.passed,
      failed: testOutput.summary.failed,
      skipped: testOutput.summary.skipped,
      failures: testOutput.failures || [],
      success: testOutput.exitCode === 0
    };
  }
}
```

## 测试先行（TDD）

1. 先新增 `test-runner-runtime-adapter.service.spec.ts`。
2. 测试 `run_test` 工具缺失时返回 `failed`。
3. 测试工具成功时返回 `AgentRunResult.status=completed`，并包含测试摘要。
4. 测试工具失败时保留失败原因。
5. 测试 `signal` 会传给工具上下文。
6. 先更新 `RuntimeType`、runtime labels/config 相关测试，确保 `test_runner` 可被识别。
7. 再实现 Runtime Adapter。

## 完成标准

### 功能标准
- [ ] TestRunnerRuntimeAdapterService 类创建完成
- [ ] `test_runner` 已加入 `RuntimeType`、runtime config/label，且没有对 `RuntimeType` 使用 `as any`
- [ ] 实现 `AgentRuntimeAdapter`
- [ ] 通过 ToolRegistry 调用工具
- [ ] 正确解析测试结果
- [ ] 返回 `AgentRunResult`

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 单元测试覆盖

## 验证命令

```bash
npm run typecheck
npm --workspace @agent-cluster/server run test -- test-runner-runtime-adapter.service.spec.ts
```

## 单元测试用例

```typescript
describe('TestRunnerRuntimeAdapterService', () => {
  let runtime: TestRunnerRuntimeAdapterService;
  let mockToolRegistry: jest.Mocked<ToolRegistryService>;
  
  beforeEach(() => {
    mockToolRegistry = { getTool: jest.fn() } as any;
    runtime = new TestRunnerRuntimeAdapterService(mockToolRegistry);
  });
  
  it('should execute tests successfully', async () => {
    const mockRunTestTool = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        output: {
          script: 'test',
          duration: 1000,
          summary: { total: 10, passed: 10, failed: 0, skipped: 0 },
          exitCode: 0
        }
      })
    };
    mockToolRegistry.getTool.mockReturnValue(mockRunTestTool as any);
    
    const result = await runtime.run({
      sessionId: 'test',
      contextPack: {
        workingDirectory: '/tmp',
        taskContext: { testPattern: '*.test.ts' }
      }
    } as any);
    
    expect(result.status).toBe('completed');
  });
});
```

## 失败策略

### 工具调用失败
- 检查 run_test 工具是否已注册
- 确认测试框架可用

### 测试执行失败
- 查看测试输出
- 检查工作目录

## 风险边界

### 中风险
- 测试可能很慢
- 测试可能修改状态

### 需要注意
- 设置合理超时
- 记录测试日志

## 交付格式

### 代码文件
- `apps/server/src/modules/runtimes/test-runner-runtime-adapter.service.ts`
- `apps/server/src/modules/runtimes/test-runner-runtime-adapter.service.spec.ts`
- `packages/shared/src/contracts.ts`
- `apps/server/src/common/runtime-config.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过
✓ Runtime 可注入
```

## 后续任务
- TASK-014: 注册所有内部 Runtime Adapter
- TASK-015: 集成测试
