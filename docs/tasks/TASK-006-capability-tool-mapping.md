# TASK-006: 定义能力-工具映射表

## 元信息
- **任务 ID**: TASK-006
- **优先级**: P0
- **预估时间**: 15 分钟
- **依赖**: TASK-003 (Tool 接口)
- **所属阶段**: Phase 1 - 能力与工具解耦

## 背景

### 现有系统已实现
- Agent 定义中有 `capabilityIds` 字段（如 `['cap-brief', 'cap-router']`）
- Capability 在 `packages/shared/src/contracts.ts` 中定义
- 默认能力在 `apps/server/src/modules/capabilities/default-capabilities.ts` 中定义
- Agent 通过 `runtimeType` 选择执行引擎
- 但没有明确的能力到工具的映射关系

### 当前问题
- Agent 声明能力 ID（如 `cap-file-write`），但不知道对应哪些具体工具
- 能力和工具之间缺少明确映射
- Agent 无法自动获取所需工具列表
- 能力与实现强耦合

### 本任务目标
建立能力到工具的映射表，实现能力与工具的解耦，让 Agent 通过能力声明自动获得所需工具。

## 目标
定义 Capability-Tool Mapping 映射表，建立能力与工具的对应关系。

## 范围

### 包含
- 创建映射表常量
- 定义常见能力的工具映射
- 导出映射表类型

### 不包含
- 动态映射逻辑
- 映射配置文件

## 技术方案

```typescript
// apps/server/src/modules/tools/capability-tool-mapping.ts

/**
 * 能力 ID 到工具名的映射表。
 * key 必须来自 RuntimeCapabilityDefinition.id，例如 cap-file-write。
 */
export const CAPABILITY_TOOL_MAPPING: Record<string, string[]> = {
  'cap-file-read': ['read_file'],
  'cap-file-write': ['read_file', 'write_file'],
  'cap-command-run': ['run_test'],
  'cap-test-report': ['run_test'],
  'cap-post-review': ['read_file', 'search_code'],
  'cap-brief': ['read_file', 'search_code'],
  'cap-router': ['read_file'],
  'cap-dry-run': ['read_file'],
  'cap-feishu-draft': [],
  'cap-code-search': ['search_code']
};

/**
 * 获取能力需要的工具列表
 */
export function getToolsForCapability(capability: string): string[] {
  return CAPABILITY_TOOL_MAPPING[capability] || [];
}

/**
 * 获取多个能力需要的所有工具（去重）
 */
export function getToolsForCapabilities(capabilities: string[]): string[] {
  const toolSet = new Set<string>();
  
  capabilities.forEach(cap => {
    const tools = getToolsForCapability(cap);
    tools.forEach(tool => toolSet.add(tool));
  });
  
  return Array.from(toolSet);
}

/**
 * 检查能力是否有对应的工具
 */
export function hasToolsForCapability(capability: string): boolean {
  const tools = getToolsForCapability(capability);
  return tools.length > 0;
}
```

> 如果新增 `cap-file-read` 或 `cap-code-search`，需要同步补到 `default-capabilities.ts` 或任务中声明“本任务只定义映射，新增能力定义由后续任务完成”。

## 测试先行（TDD）

1. 先新增 `capability-tool-mapping.spec.ts`。
2. 测试 `cap-file-write` 返回 `read_file/write_file`。
3. 测试未知能力返回空数组。
4. 测试多个能力去重。
5. 测试映射表中的 key 至少能和 `defaultCapabilities` 中已有能力对齐；新增能力必须在测试中显式列为待补定义。
6. 再实现映射表。

## 完成标准

### 功能标准
- [ ] CAPABILITY_TOOL_MAPPING 常量定义完成
- [ ] 至少包含当前默认能力中的核心能力映射
- [ ] 映射 key 使用 capability id，不使用孤立能力名
- [ ] 实现 getToolsForCapability 辅助函数
- [ ] 实现 getToolsForCapabilities 辅助函数
- [ ] 实现 hasToolsForCapability 辅助函数

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 导出所有公开函数
- [ ] 添加 JSDoc 注释

## 验证命令

```bash
# 1. TypeScript 编译
npm run typecheck

# 2. 测试辅助函数
npm --workspace @agent-cluster/server run test -- capability-tool-mapping.spec.ts
```

```powershell
# 3. 检查映射表和辅助函数
Select-String -Path apps/server/src/modules/tools/capability-tool-mapping.ts -Pattern "export const CAPABILITY_TOOL_MAPPING"
Select-String -Path apps/server/src/modules/tools/capability-tool-mapping.ts -Pattern "getToolsForCapability|getToolsForCapabilities|hasToolsForCapability"
```

## 单元测试用例

```typescript
// capability-tool-mapping.spec.ts
import { getToolsForCapability, getToolsForCapabilities, hasToolsForCapability } from './capability-tool-mapping';

describe('Capability-Tool Mapping', () => {
  it('should return tools for cap-file-write capability', () => {
    const tools = getToolsForCapability('cap-file-write');
    expect(tools).toContain('read_file');
    expect(tools).toContain('write_file');
  });
  
  it('should return unique tools for multiple capabilities', () => {
    const tools = getToolsForCapabilities(['cap-file-read', 'cap-file-write']);
    expect(tools).toContain('read_file');
    expect(tools).toContain('write_file');
    
    // read_file 只出现一次（去重）
    const readFileCount = tools.filter(t => t === 'read_file').length;
    expect(readFileCount).toBe(1);
  });
  
  it('should check if capability has tools', () => {
    expect(hasToolsForCapability('cap-file-write')).toBe(true);
    expect(hasToolsForCapability('unknown_capability')).toBe(false);
  });
  
  it('should return empty array for unknown capability', () => {
    const tools = getToolsForCapability('nonexistent');
    expect(tools).toEqual([]);
  });
});
```

## 失败策略

### 如果映射不合理
- 检查能力定义是否清晰
- 确认工具名称与实际工具一致
- 考虑能力的粒度（不要太细也不要太粗）

### 如果辅助函数错误
- 检查去重逻辑是否正确
- 确认返回值类型
- 查看单元测试输出

## 风险边界

### 低风险
- 只是常量定义和纯函数
- 不涉及副作用

### 需要注意
- 映射表要保持更新（新增工具时）
- 能力命名要规范统一
- 工具名称要与实际注册的名称一致

## 交付格式

### 代码文件
- `apps/server/src/modules/tools/capability-tool-mapping.ts`
- `apps/server/src/modules/tools/capability-tool-mapping.spec.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过 (4/4)
✓ 映射表导出正确
✓ 辅助函数可用
```

### 使用示例
```typescript
// Agent 使用示例
class CodeReaderAgent {
  capabilityIds = ['cap-file-read', 'cap-code-search'];
  
  getRequiredTools() {
    return getToolsForCapabilities(this.capabilities);
    // 返回: ['read_file', 'list_files', 'parse_ast', 'analyze_dependencies']
  }
}
```

## 后续任务
- TASK-007: 实现 CodeReader Runtime Adapter
- TASK-008: Agent 集成工具调用
