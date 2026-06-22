# TASK-003: 定义 Tool 接口和类型

## 元信息
- **任务 ID**: TASK-003
- **优先级**: P0
- **预估时间**: 15 分钟
- **依赖**: 无
- **所属阶段**: Phase 1 - 统一工具注册表

## 背景

### 现有系统已实现
- `packages/shared/src/contracts.ts` 已定义 `WorkspaceToolDescriptor`、`WorkspaceToolName`
- `apps/server/src/modules/runtimes/workspace-tools.service.ts` 已实现安全 `readFile(rootPath, input)`
- `apps/server/src/common/path-safety.ts` — 路径安全检查
- `apps/server/src/modules/runtimes/generic-llm-runtime.service.ts` — 已有 tool-calling 循环 (`runWithToolLoop`)
- 工具通过 JSON Schema 定义参数（如 `read_file_tool`）

### 当前问题
- 工具分散在各处（WorkspaceToolsService、其他服务）
- 缺少统一的 Tool 接口
- Agent 无法通过标准方式发现和调用工具
- 工具之间没有统一的错误处理和结果格式

### 本任务目标
定义服务端内部可执行 Tool 接口，并明确它和 runtime 可见的 `WorkspaceToolDescriptor` 的关系：`WorkspaceToolDescriptor` 用于告诉模型能调用什么，`Tool` 用于服务端真正执行。

## 目标
定义 Tool 统一接口，包含：
1. 工具元信息（name、description、category）
2. 参数 schema（JSON Schema 格式）
3. 执行方法
4. 相关类型定义

## 范围

### 包含
- 创建 `tool.interface.ts`
- 定义 `Tool` 接口
- 定义 `ToolExecutionContext` 类型
- 定义 `ToolResult` 类型
- 定义工具分类枚举
- 提供 `toWorkspaceToolDescriptor(tool)` 转换函数

### 不包含
- 具体工具实现
- 工具注册表服务
- 能力-工具映射

## 技术方案

```typescript
// apps/server/src/modules/tools/tool.interface.ts
import type { WorkspaceToolDescriptor } from '@agent-cluster/shared';

export type ToolCategory = 'file' | 'code' | 'test' | 'db' | 'network' | 'custom';

export interface Tool {
  // 工具元信息
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly riskLevel: 'low' | 'medium' | 'high';
  
  // 参数 schema (JSON Schema)
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  
  // 执行函数
  execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolExecutionContext {
  workingDirectory: string;
  sessionId: string;
  agentId?: string;
  taskId?: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  output: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
}

export function toWorkspaceToolDescriptor(tool: Tool): WorkspaceToolDescriptor {
  return {
    name: tool.name as WorkspaceToolDescriptor['name'],
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}
```

## 测试先行（TDD）

1. 先新增 `tool.interface.spec.ts` 或轻量 node:test，验证 `toWorkspaceToolDescriptor` 会保留 `name/description/inputSchema`。
2. 先运行 `npm --workspace @agent-cluster/server run test -- tool.interface.spec.ts`，确认测试先失败。
3. 实现接口和转换函数。
4. 再运行 `npm run typecheck` 和该 spec。

## 完成标准

### 功能标准
- [ ] Tool 接口定义完成
- [ ] ToolCategory 支持 6 种分类
- [ ] ToolExecutionContext 包含必要上下文
- [ ] ToolResult 包含成功/失败标识
- [ ] Tool 明确区分内部执行实例和 `WorkspaceToolDescriptor`
- [ ] 提供 descriptor 转换函数
- [ ] 所有类型都有 JSDoc 注释

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 接口符合 ESLint 规则
- [ ] 导出所有公开类型

## 验证命令

```bash
npm run typecheck
npm --workspace @agent-cluster/server run test -- tool.interface.spec.ts
```

```powershell
Test-Path apps/server/src/modules/tools/tool.interface.ts
Select-String -Path apps/server/src/modules/tools/tool.interface.ts -Pattern "export interface Tool"
```

## 失败策略

### TypeScript 编译失败
- 检查 JSON Schema 类型定义
- 确认所有类型都正确导出

### 接口设计不合理
- 参考现有工具实现
- 确保接口足够通用

## 风险边界

### 低风险
- 只是类型定义
- 不影响现有代码

### 需要注意
- parameters 使用 JSON Schema 标准
- 考虑未来扩展性

## 交付格式

### 代码文件
- `apps/server/src/modules/tools/tool.interface.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 文件已创建
✓ 接口导出正确
```

## 后续任务
- TASK-004: 实现 Tool Registry 服务
- TASK-005: 实现内置文件工具
