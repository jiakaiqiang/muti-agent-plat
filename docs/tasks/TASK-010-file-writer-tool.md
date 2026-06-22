# TASK-010: 实现 FileWriter 工具

## 元信息
- **任务 ID**: TASK-010
- **优先级**: P0
- **预估时间**: 20 分钟
- **依赖**: TASK-003 (Tool 接口), TASK-004 (Tool Registry)
- **所属阶段**: Phase 1 - 内置工具实现

## 背景

### 现有系统已实现
- `WorkspaceToolsService` — 已有安全 readFile 实现
- `apps/server/src/common/path-safety.ts` — 路径安全检查
- `apps/server/src/common/server-file-changes.ts` — 已有 `previousContent` 冲突保护写回
- `CapabilitiesService` 已有 `cap-file-write` 高风险确认
- 工作区写入逻辑在 `apps/web/src/stores/localWorkspace.ts`（浏览器侧）
- `fileChanges` artifact 已支持文件变更声明

### 当前问题
- 服务端缺少标准的文件写入工具
- 写入操作分散在不同位置
- 缺少写入前的安全验证统一入口
- 写入操作没有审计日志

### 本任务目标
实现 FileWriterTool，提供受控文件写入能力。该工具必须经过 `cap-file-write` 授权检查，并复用现有路径安全、`previousContent` 冲突保护和审计事件。

## 范围

### 包含
- 创建 `FileWriterTool` 类
- 实现 Tool 接口
- 复用 `applyServerLocalFileChanges` 或保持同等 `previousContent` 冲突保护
- 调用 `CapabilitiesService.checkInvocation('cap-file-write', ...)`
- 产生 `tool_called/tool_completed/tool_failed` 审计事件
- 支持 create/update/delete 对应 `RuntimeFileChange`

### 不包含
- 文件追加模式（append）
- 二进制文件写入
- 文件权限管理
- 绕过用户确认直接写源文件

## 技术方案

```typescript
// apps/server/src/modules/tools/builtin/file-writer.tool.ts
import { Injectable, Logger } from '@nestjs/common';
import { Tool, ToolExecutionContext, ToolResult } from '../tool.interface';
import { applyServerLocalFileChanges } from '../../../common/server-file-changes';
import { CapabilitiesService } from '../../capabilities/capabilities.service';

@Injectable()
export class FileWriterTool implements Tool {
  private readonly logger = new Logger(FileWriterTool.name);
  
  name = 'write_file';
  description = '受控写入工作区文件';
  category = 'file' as const;
  riskLevel = 'high' as const;
  
  inputSchema = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      content: { type: 'string', description: '目标内容' },
      previousContent: { type: ['string', 'null'], description: '预期旧内容，用于冲突检测' },
      operation: { type: 'string', enum: ['create', 'update', 'delete'], default: 'update' }
    },
    required: ['path', 'operation']
  };

  constructor(private capabilities: CapabilitiesService) {}
  
  async execute(
    params: {
      path: string;
      content?: string;
      previousContent?: string | null;
      operation?: 'create' | 'update' | 'delete';
    },
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    try {
      const approval = this.capabilities.checkInvocation('cap-file-write', {
        sessionId: context.sessionId,
        agentId: context.agentId,
        reason: `write_file ${params.operation ?? 'update'} ${params.path}`
      });
      if (!approval.allowed) {
        return {
          success: false,
          output: null,
          error: approval.code
        };
      }

      await applyServerLocalFileChanges(context.workingDirectory, [{
        path: params.path,
        operation: params.operation ?? 'update',
        content: params.content,
        previousContent: params.previousContent ?? null,
        source: 'runtime_proposed_change'
      }]);

      this.logger.log(
        `File change applied: ${params.path} in session ${context.sessionId}`
      );
      
      return {
        success: true,
        output: {
          path: params.path,
          operation: params.operation ?? 'update'
        }
      };
    } catch (error) {
      this.logger.error(`Write failed: ${error.message}`);
      return {
        success: false,
        output: null,
        error: error.message
      };
    }
  }
}
```

## 测试先行（TDD）

1. 先新增 `file-writer.tool.spec.ts`。
2. 测试未授权：mock `CapabilitiesService.checkInvocation` 返回 `allowed:false`，断言不会调用写入逻辑。
3. 测试授权写入：断言写入使用 `previousContent` 保护。
4. 测试冲突：当前文件内容与 `previousContent` 不一致时返回失败。
5. 测试路径穿越：`../` 路径必须失败。
6. 再实现工具。
7. 如接入真实事件审计，再补 e2e 覆盖 `tool_failed/tool_completed`。

## 完成标准

### 功能标准
- [ ] FileWriterTool 类创建完成
- [ ] 实现 Tool 接口的所有属性和方法
- [ ] 集成 cap-file-write 授权检查
- [ ] 复用 previousContent 冲突保护
- [ ] 支持自动创建上级目录
- [ ] 添加审计日志
- [ ] 错误处理完善

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 使用 @Injectable() 装饰器
- [ ] 单元测试覆盖

## 验证命令

```bash
npm run typecheck
npm --workspace @agent-cluster/server run test -- file-writer.tool.spec.ts
```

## 单元测试用例

```typescript
describe('FileWriterTool', () => {
  let tool: FileWriterTool;
  
  beforeEach(() => {
    tool = new FileWriterTool(mockCapabilities);
  });
  
  it('should write file successfully', async () => {
    const result = await tool.execute(
      { path: 'test.txt', content: 'hello' },
      { workingDirectory: '/tmp/test', sessionId: 'session-1' }
    );
    
    expect(result.success).toBe(true);
    expect(result.output.size).toBe(5);
  });
  
  it('should reject unauthorized write', async () => {
    mockCapabilities.checkInvocation.mockReturnValue({
      allowed: false,
      code: 'CAPABILITY_REQUIRES_CONFIRMATION'
    });
    const result = await tool.execute(
      { path: 'src/a.ts', content: 'x', operation: 'update' },
      { workingDirectory: '/tmp/test', sessionId: 'session-1' }
    );
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('CAPABILITY_REQUIRES_CONFIRMATION');
  });
});
```

## 失败策略

### 路径不安全
- 检查 workingDirectory 设置
- 确认路径未跨越工作目录边界
- 查看 path-safety 验证逻辑

### 写入失败
- 检查目录是否存在
- 确认写入权限
- 查看磁盘空间

### 测试失败
- 确认临时目录可用
- 检查 mock 配置
- 查看错误详情

## 风险边界

### 中风险
- 写文件是破坏性操作
- 可能覆盖现有文件
- 需要严格的路径检查

### 需要注意
- 严格执行路径安全检查
- 记录所有写入操作（审计）
- 大文件写入性能
- 考虑写入失败的回滚

## 交付格式

### 代码文件
- `apps/server/src/modules/tools/builtin/file-writer.tool.ts`
- `apps/server/src/modules/tools/builtin/file-writer.tool.spec.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过 (3/3)
✓ 路径安全检查生效
✓ 审计日志正常
```

## 后续任务
- TASK-011: 实现 CodeSearch 工具
- TASK-012: 实现 TestRunner 工具
