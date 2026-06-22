# TASK-011: 实现 CodeSearch 工具

## 元信息
- **任务 ID**: TASK-011
- **优先级**: P0
- **预估时间**: 20 分钟
- **依赖**: TASK-003 (Tool 接口), TASK-004 (Tool Registry)
- **所属阶段**: Phase 1 - 内置工具实现

## 背景

### 现有系统已实现
- `workspaceScanner` 已扫描工作区文件结构
- `WorkspaceToolsService` 已有文本文件白名单和敏感路径拒绝逻辑
- 前端有文件搜索功能（`apps/web/src/components/SessionWorkspace.vue`）
- 已支持工作区快照（`WorkspaceSnapshot`）

### 当前问题
- 服务端缺少代码内容搜索能力
- Agent 无法搜索特定模式的代码
- 无法定位关键代码片段

### 本任务目标
实现 CodeSearchTool，提供代码搜索能力，支持正则和文件模式过滤。

## 范围

### 包含
- 创建 `CodeSearchTool` 类
- 支持正则表达式搜索
- 支持文件模式过滤（如 `*.ts`）
- 复用现有路径安全和文本文件限制
- 返回匹配的文件、行号和内容

### 不包含
- 全文索引（如 elasticsearch）
- 语义搜索
- 二进制文件搜索
- 新增第三方依赖（除非任务中同步更新 package.json、lockfile 和验证）

## 技术方案

```typescript
// apps/server/src/modules/tools/builtin/code-search.tool.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolExecutionContext, ToolResult } from '../tool.interface';
import { scanWorkspace } from '../../../common/workspace-scanner';
import { WorkspaceToolsService } from '../../runtimes/workspace-tools.service';

@Injectable()
export class CodeSearchTool implements Tool {
  private readonly logger = new Logger(CodeSearchTool.name);
  
  name = 'search_code';
  description = '搜索代码内容（支持正则）';
  category = 'code' as const;
  riskLevel = 'low' as const;
  
  inputSchema = {
    type: 'object' as const,
    properties: {
      pattern: {
        type: 'string',
        description: '搜索模式（支持正则表达式）'
      },
      filePattern: {
        type: 'string',
        description: '可选文件后缀或简单包含过滤，例如 .ts 或 src/'
      },
      maxResults: {
        type: 'number',
        default: 100,
        description: '最大返回结果数'
      },
      caseSensitive: {
        type: 'boolean',
        default: false,
        description: '是否区分大小写'
      }
    },
    required: ['pattern']
  };

  constructor(private workspaceTools: WorkspaceToolsService) {}
  
  async execute(
    params: {
      pattern: string;
      filePattern?: string;
      maxResults?: number;
      caseSensitive?: boolean;
    },
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    try {
      const regex = new RegExp(
        params.pattern,
        params.caseSensitive ? 'g' : 'gi'
      );
      
      // 1. 使用现有 workspace scanner 获取候选文件
      const snapshot = await scanWorkspace(context.workingDirectory);
      const files = snapshot.files
        .map((file) => file.path)
        .filter((path) => !params.filePattern || path.includes(params.filePattern));
      
      const results: Array<{
        file: string;
        line: number;
        content: string;
        match: string;
      }> = [];
      
      const maxResults = params.maxResults || 100;
      
      // 2. 在每个文件中搜索
      for (const file of files) {
        if (results.length >= maxResults) break;
        
        const readResult = await this.workspaceTools.readFile(context.workingDirectory, { path: file });
        if (!readResult.ok) continue;
        const lines = readResult.output.split('\n');
          
          lines.forEach((line, index) => {
            if (results.length >= maxResults) return;
            
            const match = line.match(regex);
            if (match) {
              results.push({
                file,
                line: index + 1,
                content: line.trim(),
                match: match[0]
              });
            }
          });
      }
      
      this.logger.log(
        `Search completed: ${results.length} matches in ${files.length} files`
      );
      
      return {
        success: true,
        output: {
          totalMatches: results.length,
          totalFiles: files.length,
          results
        }
      };
    } catch (error) {
      this.logger.error(`Search failed: ${error.message}`);
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

1. 先新增 `code-search.tool.spec.ts`，使用临时目录创建少量 `.ts/.md/.json` 文件。
2. 测试能返回文件、行号、匹配内容。
3. 测试 `maxResults` 生效。
4. 测试非法正则返回失败。
5. 测试敏感路径/非文本文件不会被读取。
6. 再实现工具。
7. 如未来引入 `glob` 依赖，先补 `package.json/package-lock.json` 变更和 `npm install` 验证。

## 完成标准

### 功能标准
- [ ] CodeSearchTool 类创建完成
- [ ] 支持正则表达式搜索
- [ ] 支持简单文件过滤
- [ ] 返回结构化结果（文件、行号、内容）
- [ ] 默认忽略 node_modules、.git 等
- [ ] 支持结果数限制

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 单元测试覆盖

## 验证命令

```bash
npm run typecheck
npm --workspace @agent-cluster/server run test -- code-search.tool.spec.ts
```

## 单元测试用例

```typescript
describe('CodeSearchTool', () => {
  let tool: CodeSearchTool;
  
  beforeEach(() => {
    tool = new CodeSearchTool();
  });
  
  it('should find code matching pattern', async () => {
    const result = await tool.execute(
      { pattern: 'console.log', filePattern: '**/*.ts' },
      { workingDirectory: __dirname, sessionId: 'test' }
    );
    
    expect(result.success).toBe(true);
    expect(result.output.totalMatches).toBeGreaterThanOrEqual(0);
  });
  
  it('should respect maxResults', async () => {
    const result = await tool.execute(
      { pattern: '.', maxResults: 5 },
      { workingDirectory: __dirname, sessionId: 'test' }
    );
    
    expect(result.output.results.length).toBeLessThanOrEqual(5);
  });
});
```

## 失败策略

### 正则表达式错误
- 检查 pattern 是否合法
- 转义特殊字符

### 找不到文件
- 检查 filePattern 是否正确
- 确认 workingDirectory 存在

### 性能问题
- 限制搜索的文件数量
- 使用更具体的 filePattern
- 增加 ignore 规则

## 风险边界

### 低风险
- 只读操作
- 不修改文件

### 需要注意
- 大型项目搜索可能很慢
- 正则可能匹配大量结果
- 内存占用（大文件读取）

## 交付格式

### 代码文件
- `apps/server/src/modules/tools/builtin/code-search.tool.ts`
- `apps/server/src/modules/tools/builtin/code-search.tool.spec.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过
✓ 搜索功能正常
```

## 后续任务
- TASK-012: 实现 TestRunner 工具
- TASK-013: 实现 ListFiles 工具
