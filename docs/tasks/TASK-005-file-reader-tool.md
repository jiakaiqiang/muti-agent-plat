# TASK-005: 实现 FileReader 工具

## 元信息
- **任务 ID**: TASK-005
- **优先级**: P0
- **预估时间**: 20 分钟
- **依赖**: TASK-003 (Tool 接口), TASK-004 (Tool Registry)
- **所属阶段**: Phase 1 - 内置工具实现

## 背景

### 现有系统已实现
- `apps/server/src/modules/runtimes/workspace-tools.service.ts` — 已实现 `readFile(rootPath, input)` 方法
- `apps/server/src/common/path-safety.ts` — 路径安全检查（`safeJoin`、`assertWithinRootRealpath`、`isSensitivePath`）
- `GenericLLMRuntimeService` 中已定义 `read_file_tool` 的 JSON Schema
- 工具调用循环 `runWithToolLoop` 已实现

### 当前问题
- `readFile` 功能存在，但未包装为标准 Tool
- 无法通过 ToolRegistry 统一调用
- 缺少错误处理的标准格式
- 不符合新的 Tool 接口规范

### 本任务目标
将现有的 `WorkspaceToolsService.readFile` 包装为标准的 FileReaderTool，使其符合 Tool 接口，可以注册到 ToolRegistry。

## 目标
实现 FileReaderTool，提供文件读取能力。

## 范围

### 包含
- 创建 `FileReaderTool` 类
- 实现 Tool 接口
- 定义参数 schema
- 复用现有 WorkspaceToolsService
- 添加错误处理

### 不包含
- 文件写入功能
- 目录遍历功能

## 技术方案

```typescript
// apps/server/src/modules/tools/builtin/file-reader.tool.ts
@Injectable()
export class FileReaderTool implements Tool {
  name = 'read_file';
  description = '读取文件内容';
  category = 'file' as const;
  riskLevel = 'low' as const;
  
  inputSchema = {
    type: 'object' as const,
    properties: {
      path: { 
        type: 'string', 
        description: '文件路径（相对于工作目录）' 
      },
      encoding: { 
        type: 'string', 
        default: 'utf-8',
        description: '文件编码'
      }
    },
    required: ['path']
  };
  
  constructor(private workspaceTools: WorkspaceToolsService) {}
  
  async execute(
    params: { path: string; encoding?: string },
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    try {
      const content = await this.workspaceTools.readFile(context.workingDirectory, {
        path: params.path
      });
      
      return {
        success: content.ok,
        output: content,
        error: content.ok ? undefined : content.errorMessage
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error.message
      };
    }
  }
}
```

> 注意：`WorkspaceToolsService.readFile` 当前不抛业务错误，而是返回 `{ ok, output, errorCode, errorMessage }`。`FileReaderTool` 应保持这个错误结构，不要把失败吞成普通字符串。

## 测试先行（TDD）

1. 先新增 `file-reader.tool.spec.ts`，mock `WorkspaceToolsService.readFile(rootPath, input)`。
2. 测试成功读取：断言传入的第一个参数是 `context.workingDirectory`，第二个参数包含 `{ path }`。
3. 测试安全拒绝：mock 返回 `{ ok:false, errorCode:'SENSITIVE_PATH' }`，断言 `ToolResult.success=false`。
4. 再实现 `FileReaderTool`。
5. 最后运行 `npm --workspace @agent-cluster/server run test -- file-reader.tool.spec.ts` 和 `npm run typecheck`。

## 完成标准

### 功能标准
- [ ] FileReaderTool 类创建完成
- [ ] 实现 Tool 接口的所有属性和方法
- [ ] parameters 使用 JSON Schema 格式
- [ ] 正确处理成功和失败情况
- [ ] 复用 WorkspaceToolsService

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 使用 @Injectable() 装饰器
- [ ] 添加错误处理
- [ ] 单元测试覆盖

## 验证命令

```bash
# 1. TypeScript 编译
npm run typecheck

# 2. 单元测试
npm --workspace @agent-cluster/server run test -- file-reader.tool.spec.ts

# 3. 集成测试（可选）
node tests/e2e/workspace-tools-pull-smoke.mjs
```

## 单元测试用例

```typescript
describe('FileReaderTool', () => {
  let tool: FileReaderTool;
  let mockWorkspaceTools: jest.Mocked<WorkspaceToolsService>;
  
  beforeEach(() => {
    mockWorkspaceTools = {
      readFile: jest.fn()
    } as any;
    tool = new FileReaderTool(mockWorkspaceTools);
  });
  
  it('should read file successfully', async () => {
    mockWorkspaceTools.readFile.mockResolvedValue({
      ok: true,
      output: 'console.log("test");',
      truncated: false,
      resolvedPath: '/tmp/test.ts',
      byteLength: 20
    });
    
    const result = await tool.execute(
      { path: 'test.ts' },
      { workingDirectory: '/tmp', sessionId: 'test-session' }
    );
    
    expect(result.success).toBe(true);
    expect(result.output.output).toContain('console.log');
    expect(mockWorkspaceTools.readFile).toHaveBeenCalledWith('/tmp', { path: 'test.ts' });
  });
  
  it('should handle file not found', async () => {
    mockWorkspaceTools.readFile.mockResolvedValue({
      ok: false,
      output: '',
      truncated: false,
      errorCode: 'NOT_FOUND',
      errorMessage: 'File not found'
    });
    
    const result = await tool.execute(
      { path: 'nonexistent.ts' },
      { workingDirectory: '/tmp', sessionId: 'test-session' }
    );
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });
});
```

## 失败策略

### 如果 WorkspaceToolsService 不可用
- 检查依赖注入是否正确
- 确认 WorkspaceToolsService 已在模块中提供

### 如果读取失败
- 检查路径是否正确
- 确认文件存在且有读取权限
- 查看错误信息定位问题

### 如果测试失败
- 确认 mock 对象正确配置
- 检查异步方法是否正确 await
- 查看测试输出的错误详情

## 风险边界

### 低风险
- 只读操作，不会修改文件
- 有错误处理，不会导致崩溃

### 需要注意
- 路径安全检查（防止读取系统文件）
- 大文件读取性能（建议限制文件大小）
- 编码问题（默认 utf-8）

## 交付格式

### 代码文件
- `apps/server/src/modules/tools/builtin/file-reader.tool.ts`
- `apps/server/src/modules/tools/builtin/file-reader.tool.spec.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过 (2/2)
✓ 工具可注入
```

### 使用示例
```typescript
// 注册工具
toolRegistry.registerTool(new FileReaderTool(workspaceTools));

// 调用工具
const tool = toolRegistry.getTool('read_file');
const result = await tool.execute(
  { path: 'src/index.ts' },
  { workingDirectory: '/project', sessionId: 'session-1' }
);
```

## 后续任务
- TASK-006: 实现 FileWriter 工具
- TASK-007: 实现 CodeSearch 工具
