# TASK-004: 实现 Tool Registry 服务

## 元信息
- **任务 ID**: TASK-004
- **优先级**: P0
- **预估时间**: 15 分钟
- **依赖**: TASK-003 (Tool 接口)
- **所属阶段**: Phase 1 - 统一工具注册表

## 背景

### 现有系统已实现
- `WorkspaceToolsService` 提供文件读取功能
- `GenericLLMRuntimeService.runWithToolLoop` 已有工具调用循环
- 工具通过 JSON Schema 定义（如 `read_file_tool`）
- 工具调用结果通过 `ToolResult` 返回
- `packages/shared/src/contracts.ts` 已有 `WorkspaceToolDescriptor`

### 当前问题
- 工具散落在各处，没有集中管理
- 无法按分类（file/code/test）查询工具
- 新增工具需要手动在多处添加
- 缺少工具的统一注册和发现机制

### 本任务目标
定义了 Tool 接口后，实现 ToolRegistryService 提供集中管理，支持工具注册、查询和分类。

## 目标
实现 ToolRegistryService，提供：
1. 工具注册功能
2. 工具查询功能（按名称、分类）
3. 工具列表展示

## 范围

### 包含
- 创建 `ToolRegistryService`
- 实现 Map 存储
- 实现注册、查询、列表方法
- 支持导出 runtime 可见的 `WorkspaceToolDescriptor[]`
- 添加日志记录

### 不包含
- 工具配置文件加载
- 工具权限控制

## 技术方案

```typescript
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, Tool>();
  
  registerTool(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`Tool overwritten: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.logger.log(`Tool registered: ${tool.name} (${tool.category})`);
  }
  
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  
  getToolsByCategory(category: ToolCategory): Tool[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.category === category);
  }
  
  listAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  listDescriptors(): WorkspaceToolDescriptor[] {
    return this.listAll().map(toWorkspaceToolDescriptor);
  }
}
```

## 测试先行（TDD）

1. 先新增 `tool-registry.service.spec.ts`，覆盖注册、覆盖同名工具、按名称查询、按分类查询、descriptor 导出。
2. 先运行 `npm --workspace @agent-cluster/server run test -- tool-registry.service.spec.ts`，确认测试先失败。
3. 实现 `ToolRegistryService`。
4. 再接入 `RuntimeModule` provider，但不改变现有 `runWithToolLoop` 行为。

## 完成标准

### 功能标准
- [ ] ToolRegistryService 类创建完成
- [ ] 实现 registerTool 方法
- [ ] 实现 getTool 方法
- [ ] 实现 getToolsByCategory 方法
- [ ] 实现 listAll 方法
- [ ] 实现 listDescriptors 方法
- [ ] 添加日志记录

### 代码质量标准
- [ ] TypeScript 编译通过
- [ ] 使用 @Injectable() 装饰器
- [ ] 单元测试覆盖核心方法

## 验证命令

```bash
npm run typecheck
npm --workspace @agent-cluster/server run test -- tool-registry.service.spec.ts
```

```powershell
Select-String -Path apps/server/src/modules/tools/tool-registry.service.ts -Pattern "@Injectable\\(\\)"
```

## 失败策略

### 注册失败
- 检查 tool 是否符合接口定义
- 查看日志确认失败原因

### 查询返回 undefined
- 确认工具已成功注册
- 检查名称是否匹配

## 风险边界

### 低风险
- 内存中的 Map 操作
- 不涉及外部依赖

### 需要注意
- 同名工具会被覆盖
- 服务重启后需要重新注册

## 交付格式

### 代码文件
- `apps/server/src/modules/tools/tool-registry.service.ts`
- `apps/server/src/modules/tools/tool-registry.service.spec.ts`

### 验证输出
```bash
✓ TypeScript 编译通过
✓ 单元测试通过
✓ 服务可注入
```

## 后续任务
- TASK-005: 实现内置文件工具
- TASK-006: 定义能力-工具映射
