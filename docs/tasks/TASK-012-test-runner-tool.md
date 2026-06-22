# TASK-012: 实现 TestRunner 工具

## 元信息
- **任务 ID**: TASK-012
- **优先级**: P1
- **预估时间**: 20 分钟
- **依赖**: TASK-003 (Tool 接口), TASK-004 (Tool Registry)
- **所属阶段**: Phase 1 - 内置工具实现

## 背景

### 现有系统已实现
- `package.json` 中已定义测试脚本
- 已有 e2e 测试框架（`tests/e2e/`）
- `CapabilitiesService` 已定义 `cap-command-run` 高风险能力
- Codex/Claude runtime adapter 已有可配置测试命令执行逻辑

### 当前问题
- Agent 无法运行测试
- 无法获取测试结果结构化数据
- 无法验证代码改动是否破坏测试

### 本任务目标
实现受控 TestRunnerTool，提供测试执行能力，返回结构化测试结果。执行命令必须经过 `cap-command-run` 授权或明确限定在安全白名单内。

## 范围

### 包含
- 创建 `TestRunnerTool` 类
- 从项目 `package.json` 读取允许的测试脚本
- 执行受控测试命令
- 解析测试输出
- 返回结构化结果
- 支持 AbortSignal 取消和 timeout

### 不包含
- 测试覆盖率分析（单独工具）
- 测试生成
- 测试调试
- 任意 shell 命令执行

## 技术方案

```typescript
// apps/server/src/modules/tools/builtin/test-runner.tool.ts
import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolExecutionContext, ToolResult } from '../tool.interface';
import { CapabilitiesService } from '../../capabilities/capabilities.service';

const execAsync = promisify(exec);

@Injectable()
export class TestRunnerTool implements Tool {
  private readonly logger = new Logger(TestRunnerTool.name);
  
  name = 'run_test';
  description = '运行测试';
  category = 'test' as const;
  riskLevel = 'high' as const;
  
  inputSchema = {
    type: 'object' as const,
    properties: {
      script: {
        type: 'string',
        default: 'test',
        description: 'package.json scripts 中的测试脚本名'
      },
      timeout: {
        type: 'number',
        default: 60000,
        description: '超时时间（毫秒）'
      }
    },
    required: []
  };

  constructor(private capabilities: CapabilitiesService) {}
  
  async execute(
    params: {
      script?: string;
      timeout?: number;
    },
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    try {
      const approval = this.capabilities.checkInvocation('cap-command-run', {
        sessionId: context.sessionId,
        agentId: context.agentId,
        reason: `run npm script ${params.script ?? 'test'}`
      });
      if (!approval.allowed) {
        return { success: false, output: null, error: approval.code };
      }

      const script = params.script ?? 'test';
      if (!/^[\w:-]+$/.test(script)) {
        return { success: false, output: null, error: `Invalid npm script name: ${script}` };
      }

      const scripts = await this.detectPackageScripts(context.workingDirectory);
      if (!scripts[script]) {
        return { success: false, output: null, error: `Npm script not found: ${script}` };
      }

      const command = `npm run ${script}`;
      
      // 3. 执行测试
      const startTime = Date.now();
      const result = await execAsync(command, {
        cwd: context.workingDirectory,
        timeout: params.timeout || 60000,
        signal: context.signal,
        maxBuffer: 10 * 1024 * 1024
      }).catch(err => ({
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        exitCode: err.code || 1
      }));
      
      const duration = Date.now() - startTime;
      
      // 4. 解析测试结果
      const testResults = this.parseTestOutput(
        result.stdout,
        result.stderr,
        script
      );
      
      this.logger.log(
        `Tests completed: ${testResults.passed}/${testResults.total} passed ` +
        `in ${duration}ms`
      );
      
      return {
        success: testResults.exitCode === 0,
        output: {
          script,
          duration,
          summary: {
            total: testResults.total,
            passed: testResults.passed,
            failed: testResults.failed,
            skipped: testResults.skipped
          },
          failures: testResults.failures,
          exitCode: testResults.exitCode
        }
      };
    } catch (error) {
      this.logger.error(`Test execution failed: ${error.message}`);
      return {
        success: false,
        output: null,
        error: error.message
      };
    }
  }
  
  private async detectPackageScripts(workingDirectory: string): Promise<Record<string, string>> {
    try {
      const packageJsonPath = path.join(workingDirectory, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);
      
      return packageJson.scripts ?? {};
    } catch {
      return {};
    }
  }
  
  private parseTestOutput(stdout: string, stderr: string, script: string): any {
    // 简化版解析（不同脚本输出格式不同）
    const output = stdout + stderr;
    
    // 通用正则匹配
    const totalMatch = output.match(/(\d+)\s+tests?/i);
    const passedMatch = output.match(/(\d+)\s+passed/i);
    const failedMatch = output.match(/(\d+)\s+failed/i);
    
    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
    const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    
    return {
      total,
      passed,
      failed,
      skipped: 0,
      failures: [],
      exitCode: failed > 0 ? 1 : 0
    };
  }
}
```

## 测试先行（TDD）

1. 先新增 `test-runner.tool.spec.ts`。
2. 测试未授权：`cap-command-run` 未确认时返回失败，且不执行命令。
3. 测试脚本名非法或 package.json 中不存在时返回失败，且不执行命令。
4. 测试授权后执行 `npm run test`，用临时 package.json 和轻量脚本验证。
5. 测试 timeout 和 AbortSignal。
6. 测试测试失败时仍返回结构化 stdout/stderr/exitCode，而不是抛出未处理异常。
7. 再实现工具。
8. 最后补一个 smoke，验证 `tool_failed` / `tool_completed` 审计事件。

## 完成标准

### 功能标准
- [ ] TestRunnerTool 类创建完成
- [ ] 支持 package.json scripts 中的测试脚本
- [ ] 执行前检查 `cap-command-run`
- [ ] 解析测试输出
- [ ] 返回结构化结果
- [ ] 支持超时设置
- [ ] 支持取消信号

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 单元测试覆盖

## 验证命令

```bash
npm run typecheck
npm --workspace @agent-cluster/server run test -- test-runner.tool.spec.ts

# 手动测试
npm run test
```

## 单元测试用例

```typescript
describe('TestRunnerTool', () => {
  let tool: TestRunnerTool;
  let mockCapabilities: jest.Mocked<CapabilitiesService>;
  
  beforeEach(() => {
    mockCapabilities = {
      checkInvocation: jest.fn()
    } as any;
    tool = new TestRunnerTool(mockCapabilities);
  });
  
  it('should block before command approval', async () => {
    mockCapabilities.checkInvocation.mockReturnValue({
      allowed: false,
      code: 'CAPABILITY_REQUIRES_CONFIRMATION'
    });
    const result = await tool.execute(
      {},
      { workingDirectory: process.cwd(), sessionId: 'test' }
    );
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('CAPABILITY_REQUIRES_CONFIRMATION');
  });
  
  it('should run tests', async () => {
    mockCapabilities.checkInvocation.mockReturnValue({ allowed: true });

    const result = await tool.execute(
      { script: 'test' },
      { workingDirectory: process.cwd(), sessionId: 'test' }
    );
    
    expect(result.output?.summary).toBeDefined();
  });
});
```

## 失败策略

### 测试框架检测失败
- 检查 package.json 是否存在
- 确认测试依赖已安装

### 测试执行失败
- 检查测试命令是否正确
- 确认测试文件存在
- 查看错误输出

### 超时
- 增加 timeout 参数
- 检查测试是否卡住

## 风险边界

### 中风险
- 测试可能很慢
- 测试可能修改状态

### 需要注意
- 设置合理的超时
- 限制输出缓冲大小
- 测试失败不应影响 Agent 继续运行

## 交付格式

### 代码文件
- `apps/server/src/modules/tools/builtin/test-runner.tool.ts`
- `apps/server/src/modules/tools/builtin/test-runner.tool.spec.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过
✓ 测试执行成功
```

## 后续任务
- TASK-013: 实现 TestRunner Runtime Adapter
- TASK-014: 集成工具到 Agent
