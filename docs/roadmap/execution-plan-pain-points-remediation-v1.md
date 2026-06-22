# Agent Cluster 痛点修复执行方案 v1

> 更新时间：2026-06-22  
> 依据文档：`docs/analysis/system-pain-points-v1.md`  
> 目标：将 20 个痛点转化为具体可执行的开发任务

## 执行原则

1. **优先级驱动**：P0 > P1 > P2，优先解决阻碍用户使用的核心问题
2. **迭代交付**：每个任务都有明确的验收标准和测试用例
3. **向后兼容**：改动保持 API 向后兼容，通过 feature flag 渐进式启用
4. **测试先行**：每个任务交付前必须有 e2e 测试覆盖

## 执行时间线

- **Phase 1 (Week 1-3)**：P0 痛点修复 — 核心能力补全
- **Phase 2 (Week 4-6)**：P1 痛点修复 — 技术债务清理
- **Phase 3 (Week 7-9)**：P2 痛点优化 — 扩展性增强

---

## Phase 1: P0 痛点修复 (Week 1-3)

### 任务 1.1: 设计可插拔 Engineering Runtime 架构（支持第三方 + 自研双类型）

**痛点来源**：用户体验痛点 #1 — 核心协作能力缺失 + 可扩展性痛点 #1 — Runtime 不可扩展

**目标**：建立统一的 Runtime 注册表和适配器接口，支持**两类 Agent**：
- **第三方 Agent**：Codex、Claude Code、OpenCode、ZoCode（外部服务）
- **自研 Agent**：CodeReader、TestRunner、DocGenerator（本地自主能力）

**技术方案**：

1. **Runtime Adapter 统一接口**
   ```typescript
   // apps/server/src/modules/runtimes/runtime-adapter.interface.ts
   export interface RuntimeAdapter {
     // Runtime 元信息
     readonly name: string;
     readonly version: string;
     readonly category: 'external' | 'internal';  // 新增：分类标识
     readonly provider: string;  // 例如：'anthropic', 'openai', 'self-hosted'
     readonly capabilities: string[];
     
     // 可用性检查
     checkAvailability(): Promise<{ available: boolean; reason?: string }>;
     
     // 执行入口
     execute(input: AgentRunInput): Promise<RuntimeResult>;
     
     // 取消执行
     cancel(executionId: string): Promise<void>;
     
     // 健康检查
     healthCheck(): Promise<RuntimeHealthStatus>;
   }
   ```

2. **Runtime 配置 Schema（支持分类）**
   ```yaml
   # config/runtimes.yaml
   runtimes:
     # === 第三方 Agent (External) ===
     - name: codex
       category: external
       type: cli_adapter
       provider: anthropic
       enabled: true
       config:
         cli_path: /usr/local/bin/codex
         workspace_isolation: worktree
       capabilities:
         - code_read
         - code_edit
         - test_run
         
     - name: claude-code
       category: external
       type: cli_adapter
       provider: anthropic
       enabled: true
       config:
         cli_path: /usr/local/bin/claude
       capabilities:
         - code_read
         - code_edit
         - refactor
         
     - name: opencode
       category: external
       type: http_adapter
       provider: openai
       enabled: true
       config:
         base_url: http://localhost:8080
         api_key_env: OPENCODE_API_KEY
       capabilities:
         - code_read
         - code_edit
         
     # === 自研 Agent (Internal) ===
     - name: code-reader
       category: internal
       type: custom_agent
       provider: self-hosted
       enabled: true
       config:
         handler_class: CodeReaderAgent
       capabilities:
         - code_read
         - code_analyze
         - ast_parse
         
     - name: test-runner
       category: internal
       type: custom_agent
       provider: self-hosted
       enabled: true
       config:
         handler_class: TestRunnerAgent
       capabilities:
         - test_run
         - test_analyze
         
     - name: doc-generator
       category: internal
       type: custom_agent
       provider: self-hosted
       enabled: true
       config:
         handler_class: DocGeneratorAgent
       capabilities:
         - doc_generate
   ```

3. **Runtime Registry（按类别管理）**
   ```typescript
   // apps/server/src/modules/runtimes/runtime-registry.service.ts
   @Injectable()
   export class RuntimeRegistryService {
     private externalRuntimes = new Map<string, RuntimeAdapter>();
     private internalRuntimes = new Map<string, RuntimeAdapter>();
     
     async registerAdapter(adapter: RuntimeAdapter) {
       const { available, reason } = await adapter.checkAvailability();
       if (!available) {
         this.logger.warn(`Runtime ${adapter.name} unavailable: ${reason}`);
         return;
       }
       
       // 按类别注册
       if (adapter.category === 'external') {
         this.externalRuntimes.set(adapter.name, adapter);
         this.logger.log(`External runtime ${adapter.name} registered (provider: ${adapter.provider})`);
       } else {
         this.internalRuntimes.set(adapter.name, adapter);
         this.logger.log(`Internal runtime ${adapter.name} registered (self-hosted)`);
       }
     }
     
     getAdapter(name: string): RuntimeAdapter | undefined {
       return this.externalRuntimes.get(name) || this.internalRuntimes.get(name);
     }
     
     listByCategory(category: 'external' | 'internal'): RuntimeAdapter[] {
       return category === 'external'
         ? Array.from(this.externalRuntimes.values())
         : Array.from(this.internalRuntimes.values());
     }
     
     listAll(): RuntimeAdapter[] {
       return [...this.externalRuntimes.values(), ...this.internalRuntimes.values()];
     }
   }
   ```

4. **Runtime 智能路由（优先自研，降级第三方）**
   ```typescript
   // apps/server/src/modules/runtimes/runtime-smart-router.service.ts
   @Injectable()
   export class RuntimeSmartRouterService {
     selectRuntime(
       requiredCapabilities: string[],
       taskContext: any
     ): RuntimeAdapter {
       // 1. 优先选择自研 Agent（成本低、隐私安全、速度快）
       const internalCandidates = this.registry.listByCategory('internal')
         .filter(rt => requiredCapabilities.every(cap => rt.capabilities.includes(cap)));
       
       for (const candidate of internalCandidates) {
         if (this.isHealthy(candidate)) {
           this.logger.log(`Selected internal runtime: ${candidate.name}`);
           return candidate;
         }
       }
       
       // 2. 降级到第三方 Agent
       const externalCandidates = this.registry.listByCategory('external')
         .filter(rt => requiredCapabilities.every(cap => rt.capabilities.includes(cap)));
       
       for (const candidate of externalCandidates) {
         if (this.isHealthy(candidate)) {
           this.logger.warn(
             `Falling back to external runtime: ${candidate.name} (internal unavailable)`
           );
           return candidate;
         }
       }
       
       // 3. 最终降级到 Generic LLM
       return this.registry.getAdapter('generic_llm');
     }
   }
   ```

5. **适配器类型**
   - **第三方 Agent 适配器**：
     - CLI Adapter (Codex、Claude Code)
     - HTTP Adapter (OpenCode)
     - gRPC Adapter (ZoCode)
     - Webhook Adapter (自定义第三方服务)
   
   - **自研 Agent 适配器**：
     - Custom Agent Adapter (本地工具集成)
     - LLM-based Agent Adapter (本地 LLM + 工具)

**验收标准**：

- [ ] Runtime 配置支持 `category` 字段 (external/internal)
- [ ] Registry 可按类别注册和查询
- [ ] 智能路由优先选择 internal runtime
- [ ] 支持至少 3 种第三方适配器 (CLI/HTTP/Webhook)
- [ ] 支持至少 1 种自研适配器 (Custom Agent)
- [ ] e2e 测试：`tests/e2e/runtime-registry-smoke.mjs`

**交付时间**：Week 1 (3 天)

---

### 任务 1.2: 实现通用 CLI Runtime Adapter

**痛点来源**：用户体验痛点 #1

**目标**：实现通用的 CLI 适配器，支持 Codex、Claude Code 等任何命令行工具。

**技术方案**：

1. **通用 CLI Adapter**
   ```typescript
   // apps/server/src/modules/runtimes/adapters/cli-runtime-adapter.ts
   export class CliRuntimeAdapter implements RuntimeAdapter {
     constructor(
       private config: {
         name: string;
         cliPath: string;
         argsTemplate: string[];  // 参数模板，支持变量替换
         workspaceIsolation: 'worktree' | 'copy' | 'none';
         outputParser: 'json' | 'markdown' | 'custom';
       }
     ) {}
     
     async execute(input: AgentRunInput): Promise<RuntimeResult> {
       // 1. 准备工作目录
       const workspace = await this.prepareWorkspace(
         input.contextPack.workingDirectory,
         this.config.workspaceIsolation
       );
       
       // 2. 生成 prompt 文件
       const promptFile = await this.writePromptFile(input, workspace);
       
       // 3. 构造命令参数（变量替换）
       const args = this.config.argsTemplate.map(arg => 
         arg
           .replace('{prompt_file}', promptFile)
           .replace('{workspace}', workspace.path)
           .replace('{timeout}', String(input.budget.timeoutMs))
       );
       
       // 4. 执行命令
       const result = await this.spawnProcess(this.config.cliPath, args, {
         cwd: workspace.path,
         timeout: input.budget.timeoutMs,
         signal: input.cancellationSignal
       });
       
       // 5. 解析输出
       const parsedOutput = this.parseOutput(result.stdout, this.config.outputParser);
       
       // 6. 捕获文件变更
       const fileChanges = await this.captureFileChanges(workspace);
       
       // 7. 清理
       await this.cleanup(workspace);
       
       return this.buildResult(parsedOutput, fileChanges);
     }
   }
   ```

2. **配置示例**
   ```yaml
   # config/runtimes/codex.yaml
   name: codex
   type: cli_adapter
   cli_path: /usr/local/bin/codex
   args_template:
     - --prompt-file
     - "{prompt_file}"
     - --workspace
     - "{workspace}"
     - --timeout
     - "{timeout}"
   workspace_isolation: worktree
   output_parser: json
   
   # config/runtimes/claude-code.yaml
   name: claude-code
   type: cli_adapter
   cli_path: /usr/local/bin/claude
   args_template:
     - code
     - --file
     - "{prompt_file}"
     - --directory
     - "{workspace}"
   workspace_isolation: worktree
   output_parser: markdown
   ```

3. **Output Parser 插件化**
   ```typescript
   interface OutputParser {
     parse(raw: string): RuntimeOutput;
   }
   
   class JsonOutputParser implements OutputParser {
     parse(raw: string): RuntimeOutput {
       return JSON.parse(raw);
     }
   }
   
   class MarkdownOutputParser implements OutputParser {
     parse(raw: string): RuntimeOutput {
       // 从 markdown 提取代码块、文件变更等
     }
   }
   ```

**验收标准**：

- [ ] 成功执行 Codex 命令
- [ ] 成功执行 Claude Code 命令
- [ ] 工作区隔离生效 (worktree/copy/none)
- [ ] 文件变更正确捕获
- [ ] 支持自定义 output parser
- [ ] e2e 测试：`tests/e2e/cli-adapter-smoke.mjs`

**交付时间**：Week 1 (4 天，与 1.1 并行)

---

### 任务 1.3: 实现统一工具注册表（Tool Registry）

**痛点来源**：可扩展性痛点 — Agent 能力与工具耦合，难以复用

**目标**：建立统一的工具注册表，Agent 通过能力声明使用工具，实现能力与工具解耦。

**技术方案**：

#### 1. 工具定义接口

```typescript
// apps/server/src/modules/tools/tool.interface.ts
export interface Tool {
  // 工具元信息
  name: string;
  description: string;
  category: 'file' | 'code' | 'test' | 'db' | 'network' | 'custom';
  
  // 工具参数 schema (JSON Schema)
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
  
  // 执行函数
  execute(params: any, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolExecutionContext {
  workingDirectory: string;
  sessionId: string;
  cancellationSignal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  output: any;
  error?: string;
}
```

#### 2. 工具注册表服务

```typescript
// apps/server/src/modules/tools/tool-registry.service.ts
@Injectable()
export class ToolRegistryService {
  private tools = new Map<string, Tool>();
  
  registerTool(tool: Tool) {
    this.tools.set(tool.name, tool);
    this.logger.log(`Tool registered: ${tool.name} (${tool.category})`);
  }
  
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  
  getToolsByCategory(category: string): Tool[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.category === category);
  }
  
  listAll(): Tool[] {
    return Array.from(this.tools.values());
  }
}
```

#### 3. 能力与工具映射

```typescript
// apps/server/src/modules/tools/capability-tool-mapping.ts
export const CAPABILITY_TOOL_MAPPING = {
  // 文件能力
  'code_read': ['read_file', 'list_files'],
  'code_edit': ['read_file', 'write_file', 'delete_file'],
  'file_search': ['search_code', 'find_files'],
  
  // 代码能力
  'code_analyze': ['read_file', 'parse_ast', 'analyze_dependencies'],
  'refactor': ['read_file', 'write_file', 'parse_ast'],
  
  // 测试能力
  'test_run': ['run_test', 'parse_test_results'],
  'coverage_analyze': ['run_test', 'generate_coverage_report'],
  
  // 文档能力
  'doc_generate': ['read_file', 'parse_ast', 'generate_markdown']
};
```

#### 4. 内置工具实现

```typescript
// apps/server/src/modules/tools/builtin/file-reader.tool.ts
@Injectable()
export class FileReaderTool implements Tool {
  name = 'read_file';
  description = '读取文件内容';
  category = 'file' as const;
  
  parameters = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: '文件路径' },
      encoding: { type: 'string', default: 'utf-8' }
    },
    required: ['path']
  };
  
  constructor(private workspaceTools: WorkspaceToolsService) {}
  
  async execute(params: any, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const content = await this.workspaceTools.readFile({
        path: params.path,
        workingDirectory: context.workingDirectory
      });
      return { success: true, output: content };
    } catch (error) {
      return { success: false, output: null, error: error.message };
    }
  }
}
```

#### 5. Agent 使用工具

```typescript
// Agent 通过能力获取工具
class CodeReaderAgent extends CustomAgentAdapter {
  readonly capabilities = ['code_read', 'code_analyze'];
  
  async execute(input: AgentRunInput): Promise<RuntimeResult> {
    // 1. 根据能力获取可用工具
    const availableTools = this.getToolsForCapabilities(this.capabilities);
    
    // 2. 调用工具
    const readFileTool = this.toolRegistry.getTool('read_file');
    const result = await readFileTool.execute(
      { path: 'src/index.ts' },
      { workingDirectory: input.contextPack.workingDirectory }
    );
    
    return { kind: 'success', output: result.output };
  }
  
  private getToolsForCapabilities(capabilities: string[]): Tool[] {
    const toolNames = new Set<string>();
    capabilities.forEach(cap => {
      const tools = CAPABILITY_TOOL_MAPPING[cap] || [];
      tools.forEach(t => toolNames.add(t));
    });
    return Array.from(toolNames).map(name => this.toolRegistry.getTool(name));
  }
}
```

#### 6. 工具配置文件

```yaml
# config/tools.yaml
tools:
  # 文件工具
  - name: read_file
    category: file
    enabled: true
    
  - name: write_file
    category: file
    enabled: true
    requires_approval: true  # 需要用户确认
    
  - name: delete_file
    category: file
    enabled: false  # 默认禁用
    
  # 代码工具
  - name: search_code
    category: code
    enabled: true
    
  - name: parse_ast
    category: code
    enabled: true
    
  # 测试工具
  - name: run_test
    category: test
    enabled: true
```

**验收标准**：

- [ ] Tool 接口定义完成
- [ ] ToolRegistry 支持注册/查询工具
- [ ] 能力-工具映射表可配置
- [ ] 至少实现 5 个内置工具 (read_file/write_file/search_code/parse_ast/run_test)
- [ ] Agent 可通过 Registry 获取和调用工具
- [ ] 工具配置文件支持启用/禁用
- [ ] e2e 测试：`tests/e2e/tool-registry-smoke.mjs`

**交付时间**：Week 1-2 (3 天)

---

### 任务 1.4: 实现自研 Agent PoC（CodeReader + TestRunner + DocGenerator）

**痛点来源**：用户体验痛点 #1 — 核心协作能力缺失 + 降低对第三方依赖

**目标**：实现 3 个最有价值的自研 Agent，基于统一工具注册表，提供本地自主能力。

**技术方案**：

#### 1. Custom Agent Adapter 基础设施

```typescript
// apps/server/src/modules/runtimes/adapters/custom-agent-adapter.ts
export abstract class CustomAgentAdapter implements RuntimeAdapter {
  abstract readonly name: string;
  abstract readonly capabilities: string[];
  readonly category = 'internal' as const;
  readonly provider = 'self-hosted';
  
  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    // 自研 Agent 始终可用（本地执行）
    return { available: true };
  }
  
  abstract execute(input: AgentRunInput): Promise<RuntimeResult>;
  
  async cancel(executionId: string): Promise<void> {
    // 取消本地执行
  }
  
  async healthCheck(): Promise<RuntimeHealthStatus> {
    return { status: 'healthy', latency: 0 };
  }
}
```

#### 2. CodeReader Agent（代码读取和分析）

```typescript
// apps/server/src/modules/runtimes/agents/code-reader.agent.ts
@Injectable()
export class CodeReaderAgent extends CustomAgentAdapter {
  readonly name = 'code-reader';
  readonly capabilities = ['code_read', 'code_analyze', 'ast_parse', 'dependency_analyze'];
  
  constructor(
    private workspaceTools: WorkspaceToolsService,
    private astParser: ASTParserService
  ) {
    super();
  }
  
  async execute(input: AgentRunInput): Promise<RuntimeResult> {
    const { taskContext, workingDirectory } = input.contextPack;
    
    // 1. 识别需要读取的文件
    const targetFiles = this.identifyTargetFiles(taskContext);
    
    // 2. 读取文件内容（复用现有的 workspace-tools）
    const fileContents = await Promise.all(
      targetFiles.map(file => 
        this.workspaceTools.readFile({ path: file, workingDirectory })
      )
    );
    
    // 3. AST 解析
    const astAnalysis = await Promise.all(
      fileContents.map(content => 
        this.astParser.parse(content.content, content.path)
      )
    );
    
    // 4. 依赖分析
    const dependencies = await this.analyzeDependencies(astAnalysis);
    
    // 5. 返回结构化结果
    return {
      kind: 'success',
      output: {
        kind: 'agent_message',
        content: JSON.stringify({
          files: fileContents.map((fc, idx) => ({
            path: fc.path,
            lineCount: fc.lineCount,
            ast: astAnalysis[idx],
            imports: astAnalysis[idx].imports,
            exports: astAnalysis[idx].exports,
            functions: astAnalysis[idx].functions,
            classes: astAnalysis[idx].classes
          })),
          dependencies,
          summary: this.generateSummary(fileContents, astAnalysis)
        })
      }
    };
  }
  
  private identifyTargetFiles(taskContext: any): string[] {
    // 从 taskContext 提取目标文件
    return taskContext.targetFiles || taskContext.workspaceFocus?.relevantFiles || [];
  }
  
  private async analyzeDependencies(astAnalysis: any[]): Promise<any> {
    // 分析模块依赖关系
    const deps = new Map<string, string[]>();
    for (const ast of astAnalysis) {
      deps.set(ast.filePath, ast.imports.map(imp => imp.source));
    }
    return Object.fromEntries(deps);
  }
  
  private generateSummary(files: any[], astAnalysis: any[]): string {
    return `分析了 ${files.length} 个文件，包含 ${astAnalysis.reduce((sum, ast) => sum + ast.functions.length, 0)} 个函数。`;
  }
}
```

#### 3. TestRunner Agent（测试执行和分析）

```typescript
// apps/server/src/modules/runtimes/agents/test-runner.agent.ts
@Injectable()
export class TestRunnerAgent extends CustomAgentAdapter {
  readonly name = 'test-runner';
  readonly capabilities = ['test_run', 'test_analyze', 'coverage_analyze'];
  
  async execute(input: AgentRunInput): Promise<RuntimeResult> {
    const { workingDirectory } = input.contextPack;
    
    // 1. 检测测试框架
    const testFramework = await this.detectTestFramework(workingDirectory);
    
    // 2. 构造测试命令
    const command = this.buildTestCommand(testFramework, input.taskContext.testPattern);
    
    // 3. 执行测试
    const result = await this.executeCommand(command, {
      cwd: workingDirectory,
      timeout: input.budget.timeoutMs,
      signal: input.cancellationSignal
    });
    
    // 4. 解析测试结果
    const testResults = this.parseTestOutput(result.stdout, testFramework);
    
    // 5. 返回结构化结果
    return {
      kind: 'success',
      output: {
        kind: 'agent_message',
        content: JSON.stringify({
          framework: testFramework,
          summary: {
            total: testResults.total,
            passed: testResults.passed,
            failed: testResults.failed,
            skipped: testResults.skipped,
            duration: testResults.duration
          },
          failedTests: testResults.failures.map(f => ({
            name: f.name,
            error: f.error,
            stackTrace: f.stackTrace
          })),
          coverage: testResults.coverage
        })
      }
    };
  }
  
  private async detectTestFramework(workingDirectory: string): Promise<string> {
    // 检测 package.json 或配置文件判断测试框架
    const packageJson = await this.readPackageJson(workingDirectory);
    if (packageJson.devDependencies?.jest) return 'jest';
    if (packageJson.devDependencies?.vitest) return 'vitest';
    if (packageJson.devDependencies?.mocha) return 'mocha';
    return 'npm test';
  }
  
  private buildTestCommand(framework: string, pattern?: string): string {
    const commands = {
      jest: `npx jest ${pattern || ''}`,
      vitest: `npx vitest run ${pattern || ''}`,
      mocha: `npx mocha ${pattern || 'test/**/*.js'}`,
      'npm test': 'npm test'
    };
    return commands[framework] || commands['npm test'];
  }
  
  private parseTestOutput(stdout: string, framework: string): any {
    // 解析不同测试框架的输出格式
    // Jest: ✓ should work | ✕ should fail
    // 返回结构化结果
  }
}
```

#### 4. DocGenerator Agent（文档生成）

```typescript
// apps/server/src/modules/runtimes/agents/doc-generator.agent.ts
@Injectable()
export class DocGeneratorAgent extends CustomAgentAdapter {
  readonly name = 'doc-generator';
  readonly capabilities = ['doc_generate', 'api_doc', 'readme_generate'];
  
  constructor(
    private codeReader: CodeReaderAgent,
    private llmClient?: LocalLLMClient  // 可选：使用本地 LLM 增强
  ) {
    super();
  }
  
  async execute(input: AgentRunInput): Promise<RuntimeResult> {
    // 1. 读取代码结构
    const codeAnalysis = await this.codeReader.execute(input);
    const analysis = JSON.parse(codeAnalysis.output.content);
    
    // 2. 生成文档
    const docs = await this.generateDocs(analysis, input.taskContext.docType);
    
    // 3. 保存为 artifact
    const artifact = {
      kind: 'markdown',
      title: input.taskContext.docType === 'api' ? 'API Documentation' : 'README',
      content: docs
    };
    
    return {
      kind: 'success',
      output: {
        kind: 'task_execution_result',
        summary: `生成了 ${input.taskContext.docType} 文档`,
        changedArtifacts: [artifact]
      }
    };
  }
  
  private async generateDocs(analysis: any, docType: string): Promise<string> {
    if (docType === 'api') {
      return this.generateAPIDoc(analysis);
    } else {
      return this.generateREADME(analysis);
    }
  }
  
  private generateAPIDoc(analysis: any): string {
    let doc = '# API Documentation\n\n';
    
    for (const file of analysis.files) {
      doc += `## ${file.path}\n\n`;
      
      for (const func of file.functions) {
        doc += `### ${func.name}\n\n`;
        doc += `**参数**:\n`;
        func.params.forEach(p => {
          doc += `- \`${p.name}: ${p.type}\` - ${p.description || ''}\n`;
        });
        doc += `\n**返回值**: \`${func.returnType}\`\n\n`;
      }
    }
    
    return doc;
  }
}
```

#### 5. Agent 注册

```typescript
// apps/server/src/modules/runtimes/runtime.module.ts
@Module({
  providers: [
    // ... 现有 providers
    CodeReaderAgent,
    TestRunnerAgent,
    DocGeneratorAgent,
    {
      provide: 'CUSTOM_AGENTS',
      useFactory: (
        codeReader: CodeReaderAgent,
        testRunner: TestRunnerAgent,
        docGenerator: DocGeneratorAgent,
        registry: RuntimeRegistryService
      ) => {
        // 自动注册自研 Agent
        registry.registerAdapter(codeReader);
        registry.registerAdapter(testRunner);
        registry.registerAdapter(docGenerator);
      },
      inject: [CodeReaderAgent, TestRunnerAgent, DocGeneratorAgent, RuntimeRegistryService]
    }
  ]
})
export class RuntimeModule {}
```

**验收标准**：

- [ ] CodeReader Agent 可读取文件并生成 AST 分析
- [ ] TestRunner Agent 可运行测试并解析结果
- [ ] DocGenerator Agent 可生成 API 文档
- [ ] 所有自研 Agent 在 Registry 中注册为 `internal` 类别
- [ ] 智能路由优先选择自研 Agent
- [ ] e2e 测试：`tests/e2e/custom-agents-smoke.mjs`

**测试用例**：

```javascript
// tests/e2e/custom-agents-smoke.mjs
test('CodeReader can analyze code', async () => {
  const session = await createSession({
    userInput: '分析 src/index.ts 的代码结构',
    workingDirectory: testWorkspace,
    engineeringRuntimeType: 'code-reader'
  });
  
  const result = await waitForCompletion(session.id);
  const analysis = JSON.parse(result.output.content);
  
  assert(analysis.files.length > 0, 'Should analyze files');
  assert(analysis.files[0].ast, 'Should have AST');
  assert(analysis.dependencies, 'Should analyze dependencies');
});

test('TestRunner can run tests', async () => {
  const session = await createSession({
    userInput: '运行所有测试',
    workingDirectory: testWorkspace,
    engineeringRuntimeType: 'test-runner'
  });
  
  const result = await waitForCompletion(session.id);
  const testResults = JSON.parse(result.output.content);
  
  assert(testResults.summary.total > 0, 'Should run tests');
  assert(testResults.framework, 'Should detect framework');
});
```

**优势**：

- ✅ **零成本** — 不依赖外部付费服务
- ✅ **零延迟** — 本地执行，无网络开销
- ✅ **隐私安全** — 代码不离开本地
- ✅ **完全可控** — 可以定制任何能力
- ✅ **高可用** — 不受第三方服务影响

**交付时间**：Week 2 (5 天)

---

### 任务 1.4: 实现 HTTP/Webhook Runtime Adapter（第三方 Agent）

**痛点来源**：用户体验痛点 #1 + 功能完整性痛点 #2

**目标**：支持通过 HTTP API 或 Webhook 调用远程第三方 Agent (OpenCode、ZoCode、自定义服务)。

(保持原有方案不变)

**交付时间**：Week 2 (4 天)

---

### 任务 1.3: 实现 HTTP/Webhook Runtime Adapter

**痛点来源**：用户体验痛点 #1 + 功能完整性痛点 #2

**目标**：支持通过 HTTP API 或 Webhook 调用远程 Agent (OpenCode、ZoCode、自定义 Agent)。

**技术方案**：

1. **HTTP Adapter**
   ```typescript
   export class HttpRuntimeAdapter implements RuntimeAdapter {
     constructor(
       private config: {
         name: string;
         baseUrl: string;
         authHeader?: string;
         requestFormat: 'openai' | 'anthropic' | 'custom';
         responseFormat: 'openai' | 'anthropic' | 'custom';
       }
     ) {}
     
     async execute(input: AgentRunInput): Promise<RuntimeResult> {
       // 1. 构造请求体
       const requestBody = this.buildRequest(input, this.config.requestFormat);
       
       // 2. 发送 HTTP 请求
       const response = await fetch(`${this.config.baseUrl}/v1/execute`, {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json',
           ...(this.config.authHeader && { 'Authorization': this.config.authHeader })
         },
         body: JSON.stringify(requestBody),
         signal: input.cancellationSignal
       });
       
       // 3. 解析响应
       const responseBody = await response.json();
       return this.parseResponse(responseBody, this.config.responseFormat);
     }
     
     private buildRequest(input: AgentRunInput, format: string) {
       if (format === 'openai') {
         return {
           model: 'code-agent',
           messages: [
             { role: 'system', content: input.agent.systemPrompt },
             { role: 'user', content: JSON.stringify(input.contextPack) }
           ]
         };
       }
       
       if (format === 'custom') {
         return {
           agent: input.agent,
           contextPack: input.contextPack,
           budget: input.budget
         };
       }
     }
   }
   ```

2. **Webhook Adapter** (异步执行)
   ```typescript
   export class WebhookRuntimeAdapter implements RuntimeAdapter {
     async execute(input: AgentRunInput): Promise<RuntimeResult> {
       // 1. 生成回调 URL
       const callbackUrl = `${this.serverBaseUrl}/api/runtimes/webhook-callback/${input.executionId}`;
       
       // 2. 发送 webhook 请求
       await fetch(this.config.webhookUrl, {
         method: 'POST',
         body: JSON.stringify({
           ...input,
           callbackUrl
         })
       });
       
       // 3. 等待回调（异步）
       return this.waitForCallback(input.executionId, input.budget.timeoutMs);
     }
   }
   ```

3. **配置示例**
   ```yaml
   # config/runtimes/opencode.yaml
   name: opencode
   type: http_adapter
   base_url: http://localhost:8080
   auth_header: Bearer ${OPENCODE_API_KEY}
   request_format: openai
   response_format: openai
   
   # config/runtimes/custom-agent.yaml
   name: my-agent
   type: webhook_adapter
   webhook_url: https://my-agent.com/execute
   auth_header: Bearer ${MY_AGENT_TOKEN}
   request_format: custom
   ```

**验收标准**：

- [ ] 成功调用 HTTP API runtime
- [ ] Webhook 异步执行生效
- [ ] 支持 OpenAI/Anthropic/Custom 请求格式
- [ ] 超时和取消机制生效
- [ ] e2e 测试：`tests/e2e/http-adapter-smoke.mjs`

**交付时间**：Week 2 (4 天)

---

### 任务 1.4: Runtime 配置管理 UI

**痛点来源**：可扩展性痛点 #1 — Runtime 不可配置

**目标**：前端提供 Runtime 配置管理界面，用户可以动态添加/编辑/禁用 Runtime。

**技术方案**：

1. **Runtime 管理页面** `apps/web/src/components/RuntimeManager.vue`
   ```vue
   <template>
     <div class="runtime-manager">
       <div class="toolbar">
         <button @click="addRuntime">添加 Runtime</button>
         <button @click="refreshList">刷新列表</button>
       </div>
       
       <table class="runtime-list">
         <thead>
           <tr>
             <th>名称</th>
             <th>类型</th>
             <th>状态</th>
             <th>能力</th>
             <th>操作</th>
           </tr>
         </thead>
         <tbody>
           <tr v-for="runtime in runtimes" :key="runtime.name">
             <td>{{ runtime.name }}</td>
             <td>
               <span class="badge">{{ runtime.type }}</span>
             </td>
             <td>
               <span 
                 class="status" 
                 :class="runtime.health.status"
               >
                 {{ runtime.health.status }}
               </span>
             </td>
             <td>
               <span 
                 v-for="cap in runtime.capabilities" 
                 :key="cap"
                 class="capability-tag"
               >
                 {{ cap }}
               </span>
             </td>
             <td>
               <button @click="editRuntime(runtime)">编辑</button>
               <button @click="toggleEnabled(runtime)">
                 {{ runtime.enabled ? '禁用' : '启用' }}
               </button>
               <button @click="testRuntime(runtime)">测试</button>
             </td>
           </tr>
         </tbody>
       </table>
       
       <!-- Runtime 编辑对话框 -->
       <RuntimeEditorDialog 
         v-if="showEditor"
         :runtime="editingRuntime"
         @save="saveRuntime"
         @cancel="closeEditor"
       />
     </div>
   </template>
   ```

2. **Runtime 配置表单** — 支持不同类型的配置项
   - CLI Adapter: cli_path, args_template, workspace_isolation
   - HTTP Adapter: base_url, auth_header, request_format
   - Webhook Adapter: webhook_url, callback_url

3. **API 端点**
   ```typescript
   // apps/server/src/modules/runtimes/runtimes.controller.ts
   
   @Get('/runtimes')
   async listRuntimes() {
     return this.runtimeRegistry.listAvailable();
   }
   
   @Post('/runtimes')
   async addRuntime(@Body() config: RuntimeConfig) {
     const adapter = await this.runtimeFactory.create(config);
     await this.runtimeRegistry.registerAdapter(adapter);
     return { success: true };
   }
   
   @Put('/runtimes/:name')
   async updateRuntime(@Param('name') name: string, @Body() config: Partial<RuntimeConfig>) {
     await this.runtimeRegistry.updateConfig(name, config);
     return { success: true };
   }
   
   @Delete('/runtimes/:name')
   async removeRuntime(@Param('name') name: string) {
     await this.runtimeRegistry.unregister(name);
     return { success: true };
   }
   
   @Post('/runtimes/:name/test')
   async testRuntime(@Param('name') name: string) {
     const adapter = this.runtimeRegistry.getAdapter(name);
     const result = await adapter.healthCheck();
     return result;
   }
   ```

4. **配置持久化**
   - 保存到 `config/runtimes/` 目录
   - 支持导入/导出配置
   - 支持从环境变量读取敏感信息

**验收标准**：

- [ ] 前端可查看所有已注册 Runtime
- [ ] 可通过 UI 添加新 Runtime (CLI/HTTP/Webhook)
- [ ] 可编辑现有 Runtime 配置
- [ ] 可禁用/启用 Runtime
- [ ] 可测试 Runtime 可用性
- [ ] 配置持久化生效

**交付时间**：Week 2 (3 天)

---

### 任务 1.5: Runtime 热加载与降级策略

**痛点来源**：用户体验痛点 #1 — Runtime 不可用时无降级

**目标**：支持 Runtime 配置热加载，Runtime 不可用时自动降级。

**技术方案**：

1. **配置热加载**
   ```typescript
   // apps/server/src/modules/runtimes/runtime-config-watcher.service.ts
   @Injectable()
   export class RuntimeConfigWatcherService implements OnModuleInit {
     private watcher: FSWatcher;
     
     async onModuleInit() {
       // 监听配置目录变化
       this.watcher = watch('config/runtimes', { recursive: true });
       
       this.watcher.on('change', async (filename) => {
         this.logger.log(`Runtime config changed: ${filename}`);
         await this.reloadConfig(filename);
       });
     }
     
     private async reloadConfig(filename: string) {
       const config = await this.loadYaml(filename);
       const adapter = await this.runtimeFactory.create(config);
       await this.runtimeRegistry.registerAdapter(adapter);
     }
   }
   ```

2. **Runtime 降级策略**
   ```typescript
   // apps/server/src/modules/runtimes/runtime-fallback.service.ts
   @Injectable()
   export class RuntimeFallbackService {
     async selectRuntimeWithFallback(
       preferred: string,
       capabilities: string[]
     ): Promise<RuntimeAdapter> {
       // 1. 尝试首选 Runtime
       const preferredAdapter = this.registry.getAdapter(preferred);
       if (preferredAdapter && await this.isHealthy(preferredAdapter)) {
         return preferredAdapter;
       }
       
       // 2. 查找具有相同能力的替代 Runtime
       const alternatives = this.registry.listAvailable()
         .filter(adapter => 
           capabilities.every(cap => adapter.capabilities.includes(cap))
         );
       
       for (const alt of alternatives) {
         if (await this.isHealthy(alt)) {
           this.logger.warn(
             `Falling back to ${alt.name} (preferred ${preferred} unavailable)`
           );
           return alt;
         }
       }
       
       // 3. 最终降级到 Generic LLM
       this.logger.error(`No suitable runtime found, falling back to generic_llm`);
       return this.registry.getAdapter('generic_llm');
     }
     
     private async isHealthy(adapter: RuntimeAdapter): Promise<boolean> {
       try {
         const health = await adapter.healthCheck();
         return health.status === 'healthy';
       } catch {
         return false;
       }
     }
   }
   ```

3. **降级策略配置**
   ```yaml
   # config/runtime-fallback.yaml
   fallback_strategies:
     - preferred: codex
       alternatives: [claude-code, opencode]
       final_fallback: generic_llm
       
     - preferred: claude-code
       alternatives: [codex, opencode]
       final_fallback: generic_llm
       
     - preferred: custom-agent
       alternatives: [generic_llm]
       final_fallback: generic_llm
   ```

4. **用户通知**
   - Runtime 降级时创建 `runtime_fallback` 事件
   - 前端展示降级提示

**验收标准**：

- [ ] 配置文件修改后自动热加载
- [ ] Runtime 不可用时自动降级
- [ ] 降级策略可配置
- [ ] 降级时用户收到通知
- [ ] e2e 测试：`tests/e2e/runtime-fallback-smoke.mjs`

**交付时间**：Week 2-3 (3 天)

---

### 任务 1.6: 增加 fileChanges diff 审阅前端组件

**痛点来源**：用户体验痛点 #2 — 工作区写回缺少变更审阅

(保持原有方案不变)

**交付时间**：Week 3 (5 天)

---

### 任务 1.7: 实现 Human Runtime 适配器

**痛点来源**：功能完整性痛点 #1 — 无法等待人工确认

(保持原有方案不变)

**交付时间**：Week 3 (3 天)

---

### 任务 1.3: 增加 fileChanges diff 审阅前端组件

**痛点来源**：用户体验痛点 #2 — 工作区写回缺少变更审阅

**目标**：用户在应用 fileChanges 前能看到 before/after diff 对比，逐文件确认。

**技术方案**：

1. **新增前端组件** `apps/web/src/components/FileChangesDiffReviewer.vue`

```vue
<template>
  <div class="file-changes-diff-reviewer">
    <div class="summary">
      <h3>文件变更审阅</h3>
      <p>{{ changedFiles.length }} 个文件将被修改</p>
    </div>
    
    <div class="file-list">
      <div 
        v-for="file in changedFiles" 
        :key="file.path"
        class="file-item"
        :class="{ selected: selectedFile === file.path }"
        @click="selectFile(file.path)"
      >
        <UiIcon :name="getFileIcon(file)" />
        <span>{{ file.path }}</span>
        <span class="badge" :class="file.operation">{{ file.operation }}</span>
      </div>
    </div>
    
    <div class="diff-view" v-if="selectedFile">
      <DiffEditor 
        :before="currentContent" 
        :after="newContent"
        :conflicts="conflicts"
      />
      
      <div class="actions">
        <button @click="acceptFile(selectedFile)">接受此文件</button>
        <button @click="rejectFile(selectedFile)">跳过此文件</button>
      </div>
    </div>
    
    <div class="bottom-actions">
      <button @click="acceptAll" :disabled="hasConflicts">全部接受</button>
      <button @click="applySelected">应用已选文件</button>
      <button @click="cancel">取消</button>
    </div>
  </div>
</template>
```

2. **Diff 渲染** — 使用 `monaco-diff-editor` 或 `diff2html`

3. **冲突检测**
   - 读取本地文件当前内容
   - 对比 artifact 的 `beforeContent` 快照
   - 如果不一致 → 标记为冲突并高亮

4. **逐文件应用**
   - 用户选择接受的文件列表
   - 调用 File System Access API 写入
   - 记录应用日志到 `file_changes_applied` 事件

**验收标准**：

- [ ] 展示所有待变更文件列表
- [ ] 逐文件显示 diff（语法高亮 + 行号）
- [ ] 冲突检测生效并高亮警告
- [ ] 支持逐文件接受/拒绝
- [ ] 应用后记录审计事件

**测试用例**：

```javascript
// tests/e2e/file-changes-diff-review-smoke.mjs
test('User can review and apply fileChanges', async () => {
  // 1. 创建会话并生成 fileChanges artifact
  const session = await createSessionWithFileChanges();
  
  // 2. 前端展示 diff reviewer
  await openDiffReviewer(session.id, artifactId);
  
  // 3. 用户接受部分文件
  await acceptFile('README.md');
  await rejectFile('package.json');
  await applySelected();
  
  // 4. 验证文件写入
  const readmeContent = await readFile('README.md');
  assert(readmeContent.includes('expected change'));
  
  // 5. 验证审计事件
  const events = await getEvents(session.id);
  const applied = events.find(e => e.type === 'file_changes_applied');
  assert(applied.metadata.acceptedFiles.includes('README.md'));
});
```

**依赖项**：

- `monaco-editor` 或 `diff2html` npm 包
- File System Access API（浏览器 workingDirectory 模式）

**交付时间**：Week 2 (5 天)

---

### 任务 1.4: 实现 Human Runtime 适配器

**痛点来源**：功能完整性痛点 #1 — 无法等待人工确认

**目标**：支持任务执行中暂停等待用户输入或决策。

**技术方案**：

1. **后端适配器** `apps/server/src/modules/runtimes/human-runtime.service.ts`

```typescript
async execute(input: AgentRunInput): Promise<RuntimeResult> {
  // 1. 创建 human_confirmation_requested 事件
  const confirmationId = crypto.randomUUID();
  await this.eventsService.create({
    sessionId: input.sessionId,
    type: 'human_confirmation_requested',
    metadata: {
      confirmationId,
      question: input.agent.systemPrompt,
      options: input.expectedOutput.options, // 可选的多选项
      allowFreeText: input.expectedOutput.allowFreeText
    }
  });
  
  // 2. 等待用户响应（轮询或事件监听）
  const response = await this.waitForHumanResponse(confirmationId, {
    timeout: input.budget.timeoutMs,
    signal: input.cancellationSignal
  });
  
  // 3. 返回用户输入
  return {
    kind: 'success',
    output: {
      kind: 'agent_message',
      content: response.userInput
    }
  };
}
```

2. **前端确认卡** `apps/web/src/components/HumanConfirmationCard.vue`

```vue
<template>
  <div class="human-confirmation-card">
    <h4>{{ question }}</h4>
    
    <div v-if="options" class="options">
      <button 
        v-for="opt in options" 
        :key="opt.value"
        @click="respond(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>
    
    <textarea 
      v-if="allowFreeText"
      v-model="freeTextInput"
      placeholder="输入你的回复..."
    />
    
    <button @click="submitResponse">提交</button>
  </div>
</template>
```

3. **API 端点**
   - `POST /api/sessions/:id/human-responses/:confirmationId`
   - 接收用户输入并唤醒等待的 runtime

**验收标准**：

- [ ] Human runtime 能暂停执行并等待用户
- [ ] 前端展示确认卡
- [ ] 用户提交后任务继续执行
- [ ] 超时机制生效
- [ ] e2e 测试：`tests/e2e/human-runtime-smoke.mjs`

**交付时间**：Week 2 (3 天)

---

### 任务 1.5: 实现 MCP Tool Runtime 适配器

**痛点来源**：功能完整性痛点 #2 — 外部能力无法调用

**目标**：支持 Agent 调用外部 MCP 工具（API、数据库查询、文件操作等）。

**技术方案**：

1. **MCP Server 连接管理**
   ```typescript
   // apps/server/src/modules/runtimes/mcp-tool-runtime.service.ts
   async execute(input: AgentRunInput): Promise<RuntimeResult> {
     const toolName = input.expectedOutput.toolName;
     const toolParams = input.expectedOutput.toolParams;
     
     // 1. 查找已注册的 MCP server
     const mcpServer = await this.mcpRegistry.findServerByTool(toolName);
     if (!mcpServer) {
       throw new Error(`MCP tool not found: ${toolName}`);
     }
     
     // 2. 权限检查（基于 capability）
     await this.capabilitiesService.check(input.sessionId, toolName);
     
     // 3. 调用 MCP server
     const result = await this.mcpClient.callTool(mcpServer.url, toolName, toolParams, {
       timeout: input.budget.timeoutMs,
       signal: input.cancellationSignal
     });
     
     // 4. 记录审计日志
     await this.eventsService.create({
       type: 'mcp_tool_invoked',
       metadata: { toolName, params: toolParams, result }
     });
     
     return this.buildResult(result);
   }
   ```

2. **MCP Registry**
   - 文件：`apps/server/src/modules/mcp/mcp-registry.service.ts`
   - 支持注册/移除 MCP server
   - 工具发现与能力映射

3. **Capability 绑定**
   - 每个 MCP tool 对应一个 capability
   - 继承现有的风险分级和审批机制

**验收标准**：

- [ ] 成功连接到测试 MCP server
- [ ] 调用 MCP tool 并获取结果
- [ ] 权限检查生效
- [ ] 审计日志完整
- [ ] e2e 测试：`tests/e2e/mcp-tool-runtime-smoke.mjs`

**交付时间**：Week 3 (5 天)

---

## Phase 2: P1 痛点修复 (Week 4-6)

### 任务 2.1: PostgreSQL 数据库规范化

**痛点来源**：技术债务痛点 #1 — JSONB collection 难以查询

**目标**：将 JSONB 单字段存储拆分为规范化关系表，支持复杂查询和索引。

**技术方案**：

1. **创建 Migration 脚本** `migrations/001_normalize_schema.sql`

```sql
-- Sessions 表
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  owner_id TEXT,
  title TEXT,
  user_input TEXT,
  status TEXT NOT NULL,
  task_domain TEXT,
  task_intent TEXT,
  token_used INTEGER DEFAULT 0,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

-- Events 表（保留部分 JSONB 用于 metadata）
CREATE TABLE events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  agent_id UUID,
  task_id UUID,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL,
  INDEX idx_events_session_id (session_id),
  INDEX idx_events_type (type),
  INDEX idx_events_agent_id (agent_id),
  INDEX idx_events_created_at (created_at)
);

-- Tasks 表
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  claimed_by_agent_id UUID,
  depends_on_task_ids UUID[],
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  INDEX idx_tasks_session_id (session_id),
  INDEX idx_tasks_status (status)
);

-- Artifacts 表
CREATE TABLE artifacts (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id UUID,
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL,
  INDEX idx_artifacts_session_id (session_id),
  INDEX idx_artifacts_kind (kind)
);

-- Runtime Invocations 表（用于成本追溯）
CREATE TABLE runtime_invocations (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id UUID,
  runtime_type TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  token_used INTEGER,
  cost_usd DECIMAL(10, 6),
  duration_ms INTEGER,
  created_at TIMESTAMP NOT NULL,
  INDEX idx_invocations_session_id (session_id),
  INDEX idx_invocations_runtime_type (runtime_type),
  INDEX idx_invocations_created_at (created_at)
);
```

2. **数据迁移工具**
   - 从现有 JSONB collection 读取数据
   - 转换为关系表格式
   - 支持回滚

3. **Persistence Service 重构**
   - 保持现有 API 接口不变
   - 底层切换到关系表查询
   - 支持通过 feature flag 切换新旧实现

**验收标准**：

- [ ] Migration 脚本成功执行
- [ ] 现有数据无损迁移
- [ ] 所有 e2e 测试通过
- [ ] 查询性能提升（复杂查询从秒级到毫秒级）

**交付时间**：Week 4 (5 天)

---

### 任务 2.2: BullMQ 任务级并发调度

**痛点来源**：技术债务痛点 #2 — 任务执行串行化

**目标**：将任务粒度入队到 BullMQ，支持并发执行和幂等恢复。

**技术方案**：

1. **修改 ExecutionService**
   ```typescript
   async start(sessionId: string): Promise<void> {
     const session = await this.sessionsService.get(sessionId);
     const tasks = await this.tasksService.getReadyTasks(sessionId);
     
     // 每个 ready task 单独入队
     for (const task of tasks) {
       await this.taskQueue.add('execute-task', {
         sessionId,
         taskId: task.id,
         retryAttempt: 0
       }, {
         jobId: `${sessionId}-${task.id}`, // 幂等 key
         attempts: 3,
         backoff: { type: 'exponential', delay: 2000 }
       });
     }
   }
   ```

2. **Worker 并发处理**
   ```typescript
   // apps/server/src/modules/execution/task-worker.service.ts
   processor = async (job: Job) => {
     const { sessionId, taskId } = job.data;
     
     // 1. 乐观锁认领任务
     const claimed = await this.tasksService.claimTask(taskId, {
       agentId: job.id,
       claimedAt: new Date()
     });
     
     if (!claimed) {
       return { skipped: true, reason: 'already_claimed' };
     }
     
     // 2. 执行任务
     const result = await this.runtimeService.execute({
       sessionId,
       taskId,
       cancellationSignal: job.token // BullMQ 取消信号
     });
     
     // 3. 更新任务状态
     await this.tasksService.updateStatus(taskId, 'completed');
     
     return result;
   };
   ```

3. **依赖任务自动入队**
   - 当任务完成时，检查依赖它的任务
   - 如果依赖已满足，自动入队

**验收标准**：

- [ ] 多个 ready task 并发执行
- [ ] 任务认领幂等（同一 task 不会被执行两次）
- [ ] 依赖任务自动触发
- [ ] 失败重试机制生效
- [ ] e2e 测试：`tests/e2e/task-concurrency-smoke.mjs`

**交付时间**：Week 4-5 (7 天)

---

### 任务 2.3: Agent 与 Runtime 解耦

**痛点来源**：可扩展性痛点 #1 — Agent/Runtime 耦合不清晰

**目标**：Agent 定义只声明能力需求，Runtime 选择由 policy 层动态路由。

**技术方案**：

1. **Agent 能力需求声明**
   ```typescript
   // packages/shared/src/default-agent-presets.ts
   {
     key: 'backend',
     name: '后端 Agent',
     capabilities: [
       'code_read',      // 读取代码
       'code_edit',      // 编辑代码
       'test_run',       // 运行测试
       'db_query'        // 数据库查询
     ],
     // 移除 runtimeType 字段
   }
   ```

2. **Runtime Policy Router**
   ```typescript
   // apps/server/src/modules/runtimes/runtime-policy-router.service.ts
   selectRuntime(agent: Agent, session: Session): RuntimeType {
     // 1. 检查 session override
     if (session.engineeringRuntimeType) {
       return session.engineeringRuntimeType;
     }
     
     // 2. 根据 agent 能力需求选择
     const requiredCapabilities = agent.capabilities;
     
     if (requiredCapabilities.includes('code_edit')) {
       // 需要代码编辑能力 -> Codex 或 Claude Code
       return this.selectBestCodeRuntime(session);
     }
     
     if (requiredCapabilities.includes('mcp_tool')) {
       return 'mcp_tool';
     }
     
     // 3. 默认 Generic LLM
     return 'generic_llm';
   }
   ```

3. **Runtime 能力注册表**
   - 每个 runtime 声明支持的 capability
   - Policy router 根据能力匹配选择

**验收标准**：

- [ ] Agent 定义不再包含 runtimeType
- [ ] 新增 Agent 不需要配置 runtime
- [ ] Runtime 动态路由生效
- [ ] 所有现有 e2e 测试通过

**交付时间**：Week 5 (5 天)

---

### 任务 2.4: 完善执行中用户插话处理

**痛点来源**：用户体验痛点 #4 — 执行中插话处理不完整

**目标**：执行中的补充需求能触发任务契约更新或任务暂停。

**技术方案**：

1. **Coordinator 消息路由增强**
   ```typescript
   async routeUserMessage(sessionId: string, message: string): Promise<RoutingDecision> {
     const session = await this.sessionsService.get(sessionId);
     
     // 1. 分析消息意图
     const intent = await this.analyzeMessageIntent(message);
     
     // 2. 根据会话状态决定路由
     if (session.status === 'EXECUTING') {
       if (intent.type === 'scope_change' || intent.type === 'constraint_add') {
         // 涉及范围/约束变化 -> 暂停相关任务
         await this.pauseAffectedTasks(sessionId, intent.affectedScope);
         
         // 重新生成任务契约
         return { action: 'regenerate_brief', reason: intent.reason };
       }
       
       if (intent.type === 'clarification') {
         // 澄清问题 -> 暂停并等待
         return { action: 'wait_user', reason: intent.question };
       }
     }
     
     return { action: 'continue' };
   }
   ```

2. **影响范围分析**
   - 基于消息内容识别受影响的任务
   - 暂停相关任务，保留不受影响的任务

3. **任务契约更新流程**
   - 暂停 → 讨论 → 生成新 brief → 用户确认 → 恢复

**验收标准**：

- [ ] 执行中说"不要修改数据库"能暂停相关任务
- [ ] 补充需求触发 brief 重新生成
- [ ] 不受影响的任务继续执行
- [ ] e2e 测试：`tests/e2e/execution-user-intervention-smoke.mjs`

**交付时间**：Week 6 (5 天)

---

### 任务 2.5: 接入 pgvector 语义检索

**痛点来源**：用户体验痛点 #5 — RAG 召回质量有限

**目标**：将关键词检索升级为语义检索，提升大规模知识库召回质量。

**技术方案**：

1. **安装 pgvector 扩展**
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   
   ALTER TABLE knowledge_documents 
   ADD COLUMN embedding vector(1536);  -- OpenAI embedding 维度
   
   CREATE INDEX ON knowledge_documents 
   USING ivfflat (embedding vector_cosine_ops)
   WITH (lists = 100);
   ```

2. **Embedding Provider**
   ```typescript
   // apps/server/src/modules/rag/embedding-provider.service.ts
   async generateEmbedding(text: string): Promise<number[]> {
     // 支持多个 provider: OpenAI / Cohere / local model
     const response = await this.embeddingClient.create({
       model: 'text-embedding-ada-002',
       input: text
     });
     
     return response.data[0].embedding;
   }
   ```

3. **语义检索**
   ```typescript
   async search(query: string, limit: number): Promise<Document[]> {
     // 1. 生成 query embedding
     const queryEmbedding = await this.embeddingProvider.generate(query);
     
     // 2. 向量相似度搜索
     const results = await this.db.query(`
       SELECT *, 
              1 - (embedding <=> $1) AS similarity
       FROM knowledge_documents
       WHERE 1 - (embedding <=> $1) > 0.7
       ORDER BY similarity DESC
       LIMIT $2
     `, [JSON.stringify(queryEmbedding), limit]);
     
     return results.rows;
   }
   ```

**验收标准**：

- [ ] pgvector 扩展安装成功
- [ ] 文档入库时自动生成 embedding
- [ ] 语义检索返回相关文档
- [ ] 召回质量测试通过（准确率 > 80%）
- [ ] e2e 测试：`tests/e2e/semantic-rag-smoke.mjs`

**交付时间**：Week 6 (5 天)

---

## Phase 3: P2 痛点优化 (Week 7-9)

### 任务 3.1: 统一 BullMQ 与 in-process 执行路径

**痛点来源**：技术债务痛点 #5

**目标**：长期统一到 BullMQ 路径，确保取消/恢复/token 逻辑一致。

**技术方案**：

1. **废弃 in-process 模式** (逐步迁移)
   - 保留 `ENABLE_BULLMQ=false` 仅用于测试
   - 生产环境强制使用 BullMQ

2. **统一接口抽象**
   ```typescript
   interface ExecutionBackend {
     enqueue(sessionId: string): Promise<void>;
     cancel(sessionId: string): Promise<void>;
     pause(sessionId: string): Promise<void>;
     resume(sessionId: string): Promise<void>;
   }
   ```

3. **迁移指南文档**
   - 记录 in-process 到 BullMQ 的迁移步骤
   - 提供配置检查工具

**交付时间**：Week 7 (3 天)

---

### 任务 3.2: Runtime Invocation 结构化审计

**痛点来源**：技术债务痛点 #4

**目标**：独立的 invocations 表，支持成本追溯和审计。

**技术方案**：

已在任务 2.1 中创建表结构，此任务补充：

1. **成本计算服务**
   ```typescript
   calculateCost(invocation: RuntimeInvocation): number {
     const rates = {
       'generic_llm': { input: 0.0001, output: 0.0002 },
       'codex': { per_call: 0.01 },
       'claude_code': { input: 0.00015, output: 0.0003 }
     };
     
     return invocation.tokenUsed.input * rates[invocation.runtimeType].input +
            invocation.tokenUsed.output * rates[invocation.runtimeType].output;
   }
   ```

2. **成本报表 API**
   - `GET /api/sessions/:id/cost-report`
   - `GET /api/cost-report?from=&to=`

**交付时间**：Week 7 (4 天)

---

### 任务 3.3-3.6: 其他 P2 优化

包括 Workflow Template 配置化、Capability 版本管理、事件流索引优化、前端同步中间件等。

详细方案见上文 Phase 3 各任务。

---

## 附录：测试策略与交付标准

### E2E 测试覆盖

每个任务都有对应的 e2e 测试文件，覆盖核心场景、边界情况和错误处理。

### 交付检查清单

**Phase 1**: Codex/Claude/Human/MCP Runtime + FileChanges diff 审阅  
**Phase 2**: PostgreSQL 规范化 + 任务并发 + Agent/Runtime 解耦 + 语义检索  
**Phase 3**: 执行路径统一 + 成本追溯 + Workflow 配置 + 事件流优化

---

## 总结

本执行方案将 20 个痛点转化为 15 个具体任务，分 3 个 phase 在 9 周内交付。

完成后，Agent Cluster 将从演示级系统升级为生产级多 Agent 协作平台。

## 架构优化说明

### 为什么要设计可插拔 Runtime 架构？

原方案的问题：
- ❌ 硬编码 Codex/Claude 适配器，难以扩展
- ❌ 新增 Runtime (OpenCode/ZoCode/自定义) 需要改代码
- ❌ Runtime 配置分散在多个文件中
- ❌ 无法动态热加载新 Runtime
- ❌ Runtime 故障无降级机制

优化后的架构：
- ✅ **统一适配器接口** — 所有 Runtime 实现相同接口
- ✅ **可配置** — YAML 配置文件定义 Runtime 行为
- ✅ **可插拔** — 通过 Registry 动态注册/移除 Runtime
- ✅ **多类型支持** — CLI/HTTP/gRPC/Webhook 适配器
- ✅ **热加载** — 修改配置文件自动生效
- ✅ **降级策略** — Runtime 不可用时自动切换备选方案
- ✅ **UI 管理** — 前端可视化配置 Runtime

### Runtime 扩展示例

**添加 OpenCode Runtime** (无需改代码)：

```yaml
# config/runtimes/opencode.yaml
name: opencode
type: http_adapter
enabled: true
config:
  base_url: http://localhost:8080
  auth_header: Bearer ${OPENCODE_API_KEY}
  request_format: openai
  response_format: openai
capabilities:
  - code_read
  - code_edit
  - test_run
```

**添加 ZoCode Runtime** (无需改代码)：

```yaml
# config/runtimes/zocode.yaml
name: zocode
type: grpc_adapter
enabled: true
config:
  endpoint: localhost:50051
  tls: true
  cert_path: /path/to/cert.pem
capabilities:
  - code_read
  - code_edit
  - refactor
```

**添加自定义 Agent** (无需改代码)：

```yaml
# config/runtimes/my-custom-agent.yaml
name: my-custom-agent
type: webhook_adapter
enabled: true
config:
  webhook_url: https://my-agent.example.com/execute
  auth_header: Bearer ${MY_AGENT_TOKEN}
  callback_url: ${SERVER_BASE_URL}/api/runtimes/webhook-callback
  timeout: 600000
capabilities:
  - custom_capability_1
  - custom_capability_2
```

### Runtime 生命周期

```
1. 配置文件创建 (config/runtimes/xxx.yaml)
   ↓
2. Config Watcher 检测变化
   ↓
3. Runtime Factory 根据 type 创建 Adapter
   ↓
4. Adapter 执行 checkAvailability()
   ↓
5. Registry 注册 Adapter
   ↓
6. 前端 UI 显示新 Runtime
   ↓
7. 用户选择该 Runtime 执行任务
   ↓
8. 执行失败 → Fallback Service 降级到备选 Runtime
```

### Runtime Capability Matrix

| Runtime | code_read | code_edit | test_run | refactor | db_query | mcp_tool |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Claude Code | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| OpenCode | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| ZoCode | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Generic LLM | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP Tool | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Custom Agent | 自定义 | 自定义 | 自定义 | 自定义 | 自定义 | 自定义 |

### 降级策略示例

**场景 1**：Codex 不可用
```
用户选择 Codex → Codex 健康检查失败 → 降级到 Claude Code → 执行成功
通知用户："Codex 暂时不可用，已自动切换到 Claude Code"
```

**场景 2**：所有 CLI Runtime 不可用
```
用户选择 Codex → Codex 失败 → 尝试 Claude Code → 失败 → 尝试 OpenCode → 失败
→ 最终降级到 Generic LLM (只读分析，不能写代码)
通知用户："所有代码编辑 Runtime 不可用，已降级到只读分析模式"
```

**场景 3**：自定义 Agent webhook 超时
```
用户选择 my-custom-agent → Webhook 请求超时 (60s)
→ 降级到 Generic LLM
通知用户："自定义 Agent 响应超时，已切换到通用 LLM"
```

---

## 更新后的 Phase 1 任务清单

| 任务 | 描述 | 交付时间 |
| --- | --- | --- |
| 1.1 | 可插拔 Runtime 架构设计 (接口/Registry/Factory) | Week 1 (3天) |
| 1.2 | 通用 CLI Adapter (支持 Codex/Claude Code/任意 CLI) | Week 1 (4天) |
| 1.3 | HTTP/Webhook Adapter (支持 OpenCode/ZoCode/自定义) | Week 2 (4天) |
| 1.4 | Runtime 配置管理 UI | Week 2 (3天) |
| 1.5 | Runtime 热加载与降级策略 | Week 2-3 (3天) |
| 1.6 | FileChanges diff 审阅组件 | Week 3 (5天) |
| 1.7 | Human Runtime 适配器 | Week 3 (3天) |

**总计**：25 天 (约 3-4 周，考虑并行)

---

## 与原方案对比

| 维度 | 原方案 | 优化后方案 |
| --- | --- | --- |
| 扩展性 | 每个 Runtime 单独实现，改代码 | 统一接口 + 配置文件，零代码扩展 |
| 配置方式 | 硬编码在 adapter 中 | YAML 配置文件 + UI 管理 |
| 热加载 | 不支持，需重启 | 支持，自动检测配置变化 |
| 降级策略 | 无 | 自动降级 + 用户通知 |
| 支持的 Runtime | Codex、Claude Code | **任意** CLI/HTTP/gRPC/Webhook |
| 健康检查 | 执行时才发现故障 | 启动时 + 定期健康检查 |
| 用户体验 | 配置复杂，需要技术背景 | UI 可视化配置，降低门槛 |


## 架构优化总结：双类型 Agent 架构

### 核心价值

通过**第三方 Agent + 自研 Agent 双类型架构**，实现：
- ✅ 成本优化：高频任务用自研（零成本），复杂任务用第三方
- ✅ 隐私保护：敏感代码强制用自研 Agent
- ✅ 自主可控：不完全依赖外部服务
- ✅ 灵活降级：自研优先 → 第三方备选

### Runtime 分类对比

| 维度 | 自研 Agent | 第三方 Agent |
| --- | --- | --- |
| 成本 | 零（硬件一次性） | 按调用付费 |
| 隐私 | 代码不出本地 | 代码上传云端 |
| 可用性 | 本地运行，稳定 | 依赖网络 |
| 定制性 | 完全可控 | 受限于 API |
| 能力 | 需要自己扩展 | 功能强大 |

### 智能路由策略

```
优先级: 自研 > 第三方 > 通用 LLM

代码分析（只读） → code-reader (自研，零成本)
代码修改（复杂） → codex (第三方，功能强)
测试执行（本地） → test-runner (自研，本地快)
```

**最优成本效益比**！🚀

## 架构设计：三层解耦架构

### 完整架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Layer                            │
│  Agent 声明能力 (capabilities)                              │
│  - CodeReader: [code_read, code_analyze]                   │
│  - TestRunner: [test_run, coverage_analyze]                │
│  - CodeEditor: [code_read, code_edit]                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ 映射
                       ↓
┌─────────────────────────────────────────────────────────────┐
│              Capability-Tool Mapping Layer                  │
│  能力 → 工具映射表                                          │
│  - code_read   → [read_file, list_files]                   │
│  - code_edit   → [read_file, write_file]                   │
│  - test_run    → [run_test, parse_test_results]            │
└──────────────────────┬──────────────────────────────────────┘
                       │ 查找
                       ↓
┌─────────────────────────────────────────────────────────────┐
│                    Tool Registry                            │
│  统一工具注册表                                             │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │ read_file  │  │write_file  │  │ run_test   │           │
│  ├────────────┤  ├────────────┤  ├────────────┤           │
│  │ execute()  │  │ execute()  │  │ execute()  │           │
│  │ - params   │  │ - params   │  │ - params   │           │
│  │ - context  │  │ - context  │  │ - context  │           │
│  └────────────┘  └────────────┘  └────────────┘           │
└──────────────────────┬──────────────────────────────────────┘
                       │ 调用
                       ↓
┌─────────────────────────────────────────────────────────────┐
│               Tool Implementation Layer                     │
│  工具具体实现                                               │
│  - WorkspaceToolsService (已有)                            │
│  - FileSystemService                                       │
│  - TestRunnerService                                       │
│  - CodeSearchService                                       │
│  - ASTParserService                                        │
└─────────────────────────────────────────────────────────────┘
```

### 三层解耦的优势

#### 1. Agent Layer（能力声明层）
- Agent 只声明需要的能力 (capabilities)
- 不关心底层工具实现
- 易于扩展新 Agent

#### 2. Capability-Tool Mapping（映射层）
- 能力到工具的灵活映射
- 一个能力可对应多个工具
- 可配置、可动态调整

#### 3. Tool Registry（工具注册层）
- 统一管理所有工具
- 工具独立实现和测试
- 支持启用/禁用/权限控制

---

## 工具分类与内置工具清单

### 文件工具 (file)
| 工具名称 | 描述 | 参数 | 状态 |
| --- | --- | --- | --- |
| read_file | 读取文件内容 | path, encoding | ✅ 已实现 |
| write_file | 写入文件内容 | path, content | 🔧 待实现 |
| delete_file | 删除文件 | path | 🔧 待实现 |
| list_files | 列出目录文件 | dir, pattern | 🔧 待实现 |
| copy_file | 复制文件 | src, dest | 📝 计划中 |

### 代码工具 (code)
| 工具名称 | 描述 | 参数 | 状态 |
| --- | --- | --- | --- |
| search_code | 搜索代码 | pattern, filePattern | 🔧 待实现 |
| parse_ast | 解析 AST | code, language | 🔧 待实现 |
| analyze_dependencies | 分析依赖 | filePath | 🔧 待实现 |
| find_definition | 查找定义 | symbol, filePath | 📝 计划中 |
| find_references | 查找引用 | symbol, filePath | 📝 计划中 |

### 测试工具 (test)
| 工具名称 | 描述 | 参数 | 状态 |
| --- | --- | --- | --- |
| run_test | 运行测试 | testPattern, framework | 🔧 待实现 |
| parse_test_results | 解析测试结果 | output, framework | 🔧 待实现 |
| generate_coverage_report | 生成覆盖率报告 | - | 📝 计划中 |

### 数据库工具 (db)
| 工具名称 | 描述 | 参数 | 状态 |
| --- | --- | --- | --- |
| execute_sql | 执行 SQL | query, params | 📝 计划中 |
| parse_query_results | 解析查询结果 | results | 📝 计划中 |

### 网络工具 (network)
| 工具名称 | 描述 | 参数 | 状态 |
| --- | --- | --- | --- |
| http_request | HTTP 请求 | url, method, body | 📝 计划中 |
| webhook_call | 调用 Webhook | url, payload | 📝 计划中 |

---

## 扩展示例

### 示例 1: 添加新工具

```typescript
// 1. 实现工具
@Injectable()
export class GitStatusTool implements Tool {
  name = 'git_status';
  description = '获取 Git 状态';
  category = 'code' as const;
  
  parameters = {
    type: 'object' as const,
    properties: {},
    required: []
  };
  
  async execute(params: any, context: ToolExecutionContext): Promise<ToolResult> {
    const result = await exec('git status --porcelain', { 
      cwd: context.workingDirectory 
    });
    return { success: true, output: result.stdout };
  }
}

// 2. 注册到 Registry
toolRegistry.registerTool(new GitStatusTool());

// 3. 更新能力映射
CAPABILITY_TOOL_MAPPING['git_operations'] = ['git_status', 'git_diff', 'git_commit'];
```

### 示例 2: Agent 使用多个工具

```typescript
class CodeRefactorAgent extends CustomAgentAdapter {
  capabilities = ['code_read', 'code_edit', 'code_analyze'];
  
  async execute(input: AgentRunInput): Promise<RuntimeResult> {
    // 1. 读取文件
    const readTool = this.toolRegistry.getTool('read_file');
    const content = await readTool.execute({ path: 'src/index.ts' }, this.context);
    
    // 2. 解析 AST
    const parseTool = this.toolRegistry.getTool('parse_ast');
    const ast = await parseTool.execute({ code: content.output }, this.context);
    
    // 3. 重构代码（基于 AST）
    const refactoredCode = this.refactor(ast.output);
    
    // 4. 写回文件
    const writeTool = this.toolRegistry.getTool('write_file');
    await writeTool.execute({ 
      path: 'src/index.ts', 
      content: refactoredCode 
    }, this.context);
    
    return { kind: 'success', output: { refactored: true } };
  }
}
```

### 示例 3: LLM-based Agent 动态调用工具

```typescript
class LLMCodeAgent extends CustomAgentAdapter {
  async execute(input: AgentRunInput): Promise<RuntimeResult> {
    // 1. 获取可用工具列表
    const tools = this.getToolsForCapabilities(this.capabilities);
    
    // 2. 构造包含工具描述的 prompt
    const toolDescriptions = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
    
    const prompt = `
你有以下工具可用：
${JSON.stringify(toolDescriptions, null, 2)}

任务：${input.userInput}

请生成工具调用计划（JSON 格式）：
{
  "steps": [
    { "tool": "read_file", "args": { "path": "..." } },
    { "tool": "parse_ast", "args": { "code": "..." } }
  ]
}
    `;
    
    // 3. LLM 生成工具调用计划
    const plan = await this.llm.chat({ 
      messages: [{ role: 'user', content: prompt }] 
    });
    
    // 4. 执行工具调用链
    const results = [];
    for (const step of plan.steps) {
      const tool = this.toolRegistry.getTool(step.tool);
      const result = await tool.execute(step.args, this.context);
      results.push(result);
    }
    
    return { kind: 'success', output: results };
  }
}
```

---

## 更新后的 Phase 1 任务清单

| 任务 | 描述 | 类型 | 交付时间 |
| --- | --- | --- | --- |
| 1.1 | 可插拔 Runtime 架构（支持双类型） | 架构 | Week 1 (3天) |
| 1.2 | 通用 CLI Adapter (Codex/Claude Code) | 第三方 | Week 1 (4天) |
| **1.3** | **统一工具注册表（Tool Registry）** | **架构** | **Week 1-2 (3天)** |
| **1.4** | **自研 Agent PoC (基于 Tool Registry)** | **自研** | **Week 2 (5天)** |
| 1.5 | HTTP/Webhook Adapter (OpenCode/ZoCode) | 第三方 | Week 2 (4天) |
| 1.6 | Runtime 配置管理 UI (双类型 + 工具管理) | UI | Week 2-3 (3天) |
| 1.7 | Runtime 热加载与智能路由 | 架构 | Week 3 (3天) |

---

## 核心价值总结

### 三层解耦架构的优势

1. **Agent 层独立**
   - Agent 只需声明能力，不关心工具细节
   - 新增 Agent 无需了解工具实现
   - Agent 可复用相同的工具集

2. **能力映射灵活**
   - 能力到工具的映射可配置
   - 一个能力可对应多个工具
   - 可以根据场景动态调整映射

3. **工具统一管理**
   - 所有工具在 Registry 集中管理
   - 工具独立开发和测试
   - 支持版本管理和权限控制

4. **易于扩展**
   - 新增工具：实现 Tool 接口 + 注册
   - 新增能力：更新映射表
   - 新增 Agent：声明能力即可

5. **完全可测试**
   - 每个工具独立单元测试
   - 能力映射独立测试
   - Agent 可 mock 工具测试

---

**通过三层解耦架构，实现 Agent 能力与工具实现的完全解耦，大幅提升系统的可扩展性和可维护性！** 🚀
