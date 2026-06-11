# 工作区感知聊天 Agent 设计 v1

## 目的

本文档记录 Agent Cluster 已确认的产品方向：

Agent Cluster 仍然是一个聊天室式的多 Agent 协作平台，不应演变为 Codex 或 Claude Code 的终端优先克隆版。不过，当用户提交需求并由 Agent 执行任务时，平台应借鉴 Codex、Claude Code 等编码 Agent 的“工作区感知”工作模式。

具体来说，Agent 在理解、拆解和执行用户需求之前，应先分析用户选定的工作目录。

## 核心产品定位

用户体验仍然是：

```text
用户
  -> 聊天室会话
  -> Coordinator 接收需求
  -> 选定 Agent 参与讨论
  -> 用户确认任务合同
  -> Agent 执行任务
  -> 聊天室展示输出、diff、验证、review 和交付
```

工作模式调整为：

```text
选定工作目录
  -> 工作区扫描和文件上下文
  -> 需求理解
  -> 需求拆解
  -> Agent 讨论
  -> 用户确认
  -> 基于工作区文件执行任务
  -> review 和交付
```

## 已确认需求

1. 用户选定的目录就是当前会话的工作区。
2. 用户选定的目录不只是生成产物的输出文件夹。
3. Coordinator 分析用户需求之前，平台必须先检查工作区上下文。
4. Coordinator 和各 Agent 应同时基于用户消息和工作区快照进行推理。
5. 需求分析、任务拆解和执行应基于真实文件、项目结构和现有实现。
6. 如果需求涉及代码或文档修改，Agent 应定位并修改选定工作区中的对应文件。
7. 聊天室可见性仍然是核心：每个阶段都应以用户可读的 Agent 输出、产物、状态、文件 diff、验证结果和确认卡片呈现。
8. 阶段输出不应被强制固定为某些产物文件名或固定 markdown 格式，而应根据用户需求和受影响的工作区文件动态生成。

## 正确的端到端流程

```text
1. 用户创建聊天室会话。
2. 用户选择本地工作目录。
3. 前端在浏览器授权后扫描工作目录。
4. 前端创建工作区快照：
   - 目录树
   - 选定的可读文本文件
   - 被跳过的文件及原因
   - 检测到的项目信号
5. 前端将用户需求、选定 Agent、工作目录元数据和工作区快照发送到后端。
6. 后端存储会话和工作区快照。
7. Coordinator 在聊天室中接收需求。
8. Coordinator 先分析工作区快照，再解释用户需求。
9. Coordinator 在聊天室中输出需求理解和任务拆解。
10. 其他选定 Agent 基于同一份工作区上下文进行讨论。
11. 用户确认或修订任务合同。
12. Agent 基于工作区上下文执行任务。
13. 如果需要修改文件，runtime 输出针对真实工作区路径的具体文件变更。
14. 前端展示具体 diff 或变更内容。
15. 经用户确认的文件变更被写回选定工作区。
16. Review Agent 对比已确认的任务合同、实际变更和验证输出。
17. 最终交付总结已完成工作、风险、产物以及可选通知。
```

## 工作区快照

后端不能直接读取用户浏览器中的本地目录。前端必须在用户授权后读取该目录，并向后端发送有边界的工作区快照。

建议合同如下：

```ts
type WorkspaceSnapshot = {
  rootName: string;
  scannedAt: string;
  fileCount: number;
  totalBytes: number;
  tree: WorkspaceTreeNode[];
  files: WorkspaceFileSnapshot[];
  skipped: WorkspaceSkippedFile[];
  detectedStack?: string[];
  entrypoints?: string[];
};

type WorkspaceTreeNode = {
  path: string;
  kind: 'file' | 'directory';
  children?: WorkspaceTreeNode[];
};

type WorkspaceFileSnapshot = {
  path: string;
  size: number;
  language?: string;
  content?: string;
  summary?: string;
};

type WorkspaceSkippedFile = {
  path: string;
  reason:
    | 'ignored_directory'
    | 'binary'
    | 'too_large'
    | 'sensitive'
    | 'limit_exceeded'
    | 'read_error';
};
```

## 工作区扫描规则

默认跳过目录：

- `.git`
- `node_modules`
- `dist`
- `build`
- `.next`
- `.cache`
- `coverage`
- 生成产物目录

默认跳过敏感文件：

- `.env`
- `.env.*`
- 文件名暗示 secrets、私钥、证书或凭据的文件

默认优先读取文件：

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `package.json`
- lock 文件，作为元数据或摘要读取
- 框架配置文件
- `src/`、`apps/`、`packages/` 或项目特定入口目录下的源文件

必须设置硬限制：

- 最大扫描文件数
- 最大可读文件数
- 单文件最大字节数
- 内容总字节数上限
- 总预估 token 上限

## Context Pack 调整

`ContextPack` 应包含工作区上下文：

```ts
type ContextPack = {
  sessionGoal: string;
  workingDirectory?: SessionWorkingDirectory;
  workspaceSnapshot?: WorkspaceSnapshot;
  workspaceFocus?: {
    relevantFiles: string[];
    possibleEntryPoints: string[];
    detectedStack: string[];
    rationale: string;
  };
  taskBrief?: RuntimeTaskBrief;
  currentTask?: RuntimeAgentTask;
  agentProfile: RuntimeAgentProfile;
  relevantEvents: RuntimeEventSummary[];
  relevantMemories: RuntimeMemoryItem[];
  ragSnippets: RuntimeRagSnippet[];
  artifacts: RuntimeArtifactSummary[];
  capabilities: RuntimeCapabilityDefinition[];
  constraints: string[];
  budget: RuntimeBudget;
};
```

Coordinator 和 runtime prompt 应明确要求：

```text
先分析 workspaceSnapshot，再分析用户需求。
将工作区文件作为主要项目上下文。
不要编造不存在的文件。
如果提出修改，尽量指向真实工作区路径。
如果工作区快照不足，应询问澄清或请求更多文件。
```

## 动态阶段输出

阶段输出应继续在聊天室中可见，但不应被强制绑定到固定文件名或固定 markdown 结构。

示例：

- 对于前端样式需求：
  - 工作区分析
  - 受影响的组件和样式文件
  - CSS diff
  - 视觉验证说明
- 对于后端 API 需求：
  - 路由、服务和测试影响分析
  - 合同变更
  - 实现文件变更
  - API 验证输出
- 对于纯规划需求：
  - 需求理解
  - 受影响区域
  - 风险和未决问题
  - 除非用户要求生成文档，否则不写入工作区

`agent-output/` 仍可用于可选分析或交付总结，但当用户任务要求修改既有文件时，它不能替代真实工作区文件编辑。

## 文件变更策略

文件变更应使用安全的工作区相对路径：

```ts
type RuntimeFileChange = {
  path: string;
  operation: 'create' | 'update' | 'delete';
  content?: string;
  encoding?: 'utf-8';
};
```

规则：

1. 路径必须保持在选定工作区内。
2. 当任务指向既有实现时，应原地更新现有文件。
3. 只有任务确实需要时，才创建新文件。
4. 删除操作必须有充分理由，并需要用户可见确认。
5. 前端在应用变更前或应用过程中，必须展示具体变更内容或 diff。

## 聊天室可见性

聊天室应清晰展示以下阶段输出：

- 工作区扫描摘要
- 相关文件和被跳过文件
- Coordinator 的需求理解
- Agent 讨论结论
- 任务合同和建议任务
- 执行计划
- 文件变更和 diff
- 验证结果
- review 报告
- 最终交付
- 飞书通知确认

内部实现细节可以隐藏，但用户的心智模型应保持为：“Agent 团队查看了我的工作区，理解了任务，完成了讨论，并修改了正确的文件。”

## 非目标

该方向不意味着：

- 用终端替代聊天室 UI
- 让用户直接操作 Codex 或 Claude Code
- 移除多 Agent 讨论
- 把整个过程隐藏在一次编码 Agent 运行之后
- 盲目读取所有本地文件
- 未经过滤就发送敏感本地文件

## 当前实现差距

当前实现已部分支持选择本地目录和应用 `fileChanges`，但尚未实现正确的工作区感知流程：

- 前端在创建会话前尚未扫描或读取选定工作区
- 后端只接收工作目录元数据，而不是工作区文件上下文
- Coordinator 生成任务简报前尚未分析工作区文件
- 多个阶段产物仍然是固定 markdown 风格输出
- 执行结果仍可能在 `agent-output/` 下生成文件，而不是修改真实受影响的工作区文件

## 实现方向

建议按以下批次实现：

1. 增加共享工作区快照合同。
2. 增加带安全过滤和大小限制的前端工作区扫描器。
3. 创建会话时发送工作区快照。
4. 在会话和后端侧存储工作区快照。
5. 将工作区上下文注入 Coordinator 讨论和 runtime `ContextPack`。
6. 让阶段输出由用户需求驱动，而不是由固定文件名驱动。
7. 执行 `fileChanges` 时优先使用真实工作区文件路径。
8. 保持所有阶段输出在聊天室中可见。
