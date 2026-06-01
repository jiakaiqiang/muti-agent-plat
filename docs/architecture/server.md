# NestJS 后端架构与目录规范

本文档描述当前项目 `apps/server` 的真实 NestJS 后端结构，并把后续开发约束落到本仓库现状上。生成或修改后端代码时，优先级为：用户需求、本规范、NestJS 官方最佳实践。

## 技术栈

- 运行时：NestJS 10，入口为 `apps/server/src/main.ts`。
- 模块根：`apps/server/src/app.module.ts`。
- 共享契约：优先从 `@agent-cluster/shared` 引入领域类型和 API 契约。
- 持久化：当前由 `PersistenceService` 统一抽象，支持本地 JSON 文件和 PostgreSQL collection 表；尚未引入 TypeORM/Prisma 形式的 Entity、Repository、Migration 体系。
- API 包装：成功响应使用 `ok(data)`，错误响应由 `ApiExceptionFilter` 统一转换。
- 日志：默认 Nest `Logger`，`LOG_FORMAT=json` 时使用 `JsonLogger`。

`main.ts` 已统一设置：

- 全局路由前缀 `/api`
- CORS 白名单
- 基础安全响应头
- 全局异常过滤器 `ApiExceptionFilter`

## 当前目录结构

真正的业务代码位于 `apps/server/src/modules/<feature>/`。每个一级目录都是一个 NestJS module，并通过 `app.module.ts` 接入。

```text
apps/server/src
├── app.module.ts
├── main.ts
├── common
│   ├── api-exception.filter.ts
│   ├── api-response.ts
│   ├── env.ts
│   ├── json-logger.ts
│   ├── runtime-config.ts
│   └── time.ts
└── modules
    ├── agents
    ├── artifacts
    ├── capabilities
    ├── debug
    ├── events
    ├── memory
    ├── models
    ├── ops
    ├── orchestrator
    ├── persistence
    ├── rag
    ├── runtimes
    ├── sessions
    ├── tasks
    └── user-message-router
```

同级的空脚手架目录不代表真实架构边界。新增后端能力时，应优先放入 `apps/server/src/modules/<feature>/`，不要新增并行的顶层业务目录。

## 模块职责

| 模块 | 主要职责 |
| --- | --- |
| `agents` | Agent 列表、创建、状态和默认 Agent 种子数据 |
| `artifacts` | 会话产物的记录、查询和落库抽象 |
| `capabilities` | 高风险能力开关、能力校验和审计事件 |
| `debug` | 开发态调试接口，聚合 context、runtime、RAG、token 等信息 |
| `events` | 会话事件流、Agent 消息、工具事件和状态事件 |
| `memory` | 会话记忆的写入、检索和评分 |
| `models` | 模型连接、模型配置和密钥加密存储 |
| `ops` | 健康检查、环境和运行态诊断接口 |
| `orchestrator` | 多 Agent 编排、任务简报、任务执行、交付和飞书通知 |
| `persistence` | 当前项目的数据持久化适配层，封装 file/postgres collection |
| `rag` | 知识库和检索上下文 |
| `runtimes` | mock、generic LLM、Codex、Claude Code 等 runtime 适配和工具执行 |
| `sessions` | 会话生命周期、用户消息、暂停/继续/确认流 |
| `tasks` | 会话任务列表和任务状态 |
| `user-message-router` | 用户消息意图识别和路由规划 |

## 当前依赖关系

高层流程：

```text
HTTP Controller
  -> Feature Service
  -> PersistenceService / 其他领域 Service / Runtime adapter
  -> file 或 postgres collection / 外部 LLM CLI 或 OpenAI-compatible API
```

核心模块依赖：

- `SessionsModule` 依赖 `AgentsModule`、`EventsModule`、`MemoryModule`、`UserMessageRouterModule`、`OrchestratorModule`、`RuntimeModule`，负责把用户操作转成会话状态变化。
- `OrchestratorModule` 依赖 `AgentsModule`、`EventsModule`、`RuntimeModule`、`TasksModule`、`KnowledgeModule`、`MemoryModule`、`ArtifactsModule`、`CapabilitiesModule`，是当前最重的业务编排模块。
- `RuntimeModule` 依赖 `CapabilitiesModule`、`EventsModule`、`ModelsModule`，负责 runtime 调用、工具执行和审计。
- `PersistenceModule` 只导出 `PersistenceService`，被多个 feature service 直接注入。

禁止引入循环依赖。新增模块如果需要跨模块能力，应通过 module `exports` 暴露 service，而不是在文件层面互相穿透引用。

## 分层规范

目标分层仍采用企业级 Nest 分层：

```text
Controller
  -> Service
  -> Repository 或 Persistence Adapter
  -> Database / File / External Runtime
```

当前项目尚未拆出独立 Repository 层，因此短期内允许 feature service 直接使用 `PersistenceService`。但新增复杂持久化逻辑时，应在对应 feature 下补出 repository 或 adapter，避免把查询、序列化、业务规则全部堆到 service。

推荐新增复杂模块结构：

```text
modules/<feature>
├── <feature>.module.ts
├── <feature>.controller.ts
├── <feature>.service.ts
├── dto
├── repositories
├── entities
├── interfaces
├── exceptions
└── constants
```

当前简单模块可以继续使用扁平文件结构，例如：

```text
modules/tasks
├── tasks.module.ts
├── tasks.controller.ts
└── tasks.service.ts
```

当文件职责变重时再拆目录，不为了形式提前拆空目录。

## Controller 规范

Controller 只负责 HTTP 层：

- 定义路由和方法
- 读取 `@Param()`、`@Body()` 等请求数据
- 调用本模块 service
- 用 `ok(data)` 包装成功响应

Controller 禁止：

- 编写业务编排逻辑
- 直接访问 `PersistenceService`、数据库或外部 runtime
- 直接调用其他模块的 repository
- 做复杂数据转换

当前 `SessionsController`、`AgentsController` 等整体较薄，符合方向。但部分 body 类型仍是内联 TypeScript object，后续新增接口应优先提取 DTO。

## Service 规范

Service 承载领域业务逻辑：

- 维护领域状态
- 聚合多个 service 或 repository
- 处理异常和状态转换
- 记录必要事件
- 调用 runtime、RAG、memory、artifact 等领域能力

约束：

- 单个 service 原则上不超过 500 行。
- 单个 controller 原则上不超过 200 行。
- 超过阈值时必须拆分为子服务、策略类、adapter 或 repository。
- 禁止在 service 中散落大量 SQL 或外部命令细节；这些逻辑应进入 repository/adapter。

当前需要重点治理：

- `orchestrator.service.ts` 已经超过 1900 行，应优先拆为 brief、discussion、task execution、write confirmation、delivery 等子服务。
- `generic-llm-runtime.service.ts` 已超过 500 行，应把请求构造、响应解析、JSON repair/normalization 拆出独立 helper 或 adapter。
- `tool-executor.service.ts` 接近复杂度上限，新增工具前应先抽象权限检查、进程执行和文件沙箱逻辑。

## DTO 与契约

项目当前主要依赖 `@agent-cluster/shared` 的类型契约，并在 controller 中使用内联 body 类型。后续规则：

- 对外 API 的请求和响应模型应优先沉淀到 `packages/shared/src/contracts.ts`。
- 新增 Nest HTTP 输入建议在模块下建立 `dto/`，并使用 class DTO 表达请求结构。
- 如果引入运行时校验，应统一采用 `class-validator` 和 `class-transformer`，并在 `main.ts` 注册全局 `ValidationPipe`。
- 禁止使用 `any`。确实无法静态表达时，使用 `unknown` 后显式收窄。

在全局 `ValidationPipe` 未接入前，service 仍必须对关键字段做防御式校验，并抛出 Nest 标准异常。

## 持久化与 Repository

当前持久化边界：

- `PersistenceService.getCollection(key, fallback)`
- `PersistenceService.setCollection(key, value)`
- 后端可通过环境变量选择 file 或 postgres collection 后端。

这不是传统 ORM Repository，但在本项目中承担了 repository adapter 的职责。

新增规则：

- 简单 CRUD 可以继续由 feature service 调用 `PersistenceService`。
- 一旦出现复杂查询、数据迁移、事务或跨集合一致性，应新增 `repositories/` 或专门 adapter。
- 如果未来引入 ORM，必须采用 Migration First，禁止 `synchronize: true`。
- Entity 必须包含 `id`、`createdAt`、`updatedAt` 等基础字段。
- 表结构或持久化 schema 变化需要补文档和迁移方案。

## 异常与返回格式

成功响应：

```typescript
return ok(data);
```

实际格式：

```typescript
{
  data: T,
  requestId: string
}
```

失败响应由 `ApiExceptionFilter` 统一处理：

```typescript
{
  error: {
    code: string,
    message: string,
    details?: Record<string, unknown>
  },
  requestId: string
}
```

业务代码应使用 Nest 标准异常，例如 `BadRequestException`、`NotFoundException`、`ConflictException`、`ForbiddenException`。不要直接 `throw new Error()` 给 HTTP 层。

## Runtime 与高风险工具边界

`runtimes` 是系统的高风险边界，包含：

- `RuntimeService`：统一选择 mock、generic LLM、Codex、Claude Code 等 runtime。
- `ToolExecutorService`：执行 `file_write`、`command_run`、`run_test`、`git_diff`。
- `GenericLlmRuntimeService`：OpenAI-compatible 模型调用和响应规范化。
- `CodexRuntimeAdapterService`、`ClaudeCodeRuntimeAdapterService`：CLI runtime adapter。

规则：

- 工具执行必须经过 `CapabilitiesService` 和 `CapabilityAuditService`。
- 文件写入必须限制在解析后的 workspace root 内。
- 会话的 `workspaceDir` 表示本地运行环境根目录,不是上传目录;研发和非研发 Agent 的文件读写都必须被限制在该根目录内。
- 命令执行必须受环境变量和能力策略双重控制。
- 用户确认可以作为单次 `file_write` 的授权依据，但不能绕过 workspace 沙箱。
- runtime 错误必须返回结构化 `RuntimeError`，不要把底层异常直接泄漏给前端。

## 配置与环境变量

通用配置在 `common/runtime-config.ts` 中读取，`.env.example` 必须保持同步。

规则：

- 新增环境变量必须补 `.env.example` 和相关文档。
- 密钥只允许通过环境变量或 `SecretsService` 加密存储。
- 对前端/API 返回模型连接时只能返回 `hasCredential` 等非密钥视图。
- 本地 `.env`、`.env.*`、`.claude/settings.local.json` 不得提交。

## 日志规范

允许：

- 使用 Nest `Logger`
- 使用 `JsonLogger`
- 在关键状态流中写入 `EventsService`

禁止：

- 在业务代码中使用 `console.log`
- 打印明文密钥、完整 Authorization header、用户本地路径中的敏感片段

日志应围绕 sessionId、taskId、agentId、runId 等可追踪字段组织。

## 测试规范

当前后端主要通过 `npm run typecheck`、`npm run build` 和 `tests/e2e/*.mjs` smoke 测试覆盖关键行为。

新增后端能力至少需要：

- 运行 `npm.cmd run typecheck`
- 运行 `npm.cmd run build`
- 对会话、runtime、工具执行、持久化、能力策略等高风险改动补充或更新 e2e smoke

后续如果引入 Jest 单测，优先覆盖：

- Service
- Repository/adapter
- Guard/Pipe
- runtime response parser
- tool sandbox 和 capability policy

## 命名规范

- 类名：`PascalCase`，例如 `SessionsService`。
- 变量/方法：`camelCase`。
- 常量：`UPPER_SNAKE_CASE` 或模块内语义化 `const`。
- 文件名：`kebab-case`，例如 `user-message-router.service.ts`。
- 模块文件：`<feature>.module.ts`。
- Controller 文件：`<feature>.controller.ts`。
- Service 文件：`<feature>.service.ts`。

## 新增后端功能流程

建议顺序：

1. 先确认所属 feature module，能放入现有模块就不要新建模块。
2. 更新或新增 shared contract。
3. 新增 DTO 或明确输入校验位置。
4. 实现 repository/adapter 或复用 `PersistenceService`。
5. 实现 service 业务逻辑。
6. 添加 controller 路由。
7. 更新 module imports/providers/exports。
8. 更新 `.env.example`、架构文档或 API 文档。
9. 运行 typecheck/build，并补必要 smoke 测试。

## 禁止事项

- Controller 写业务逻辑。
- Controller 直接访问数据库、`PersistenceService` 或 runtime。
- Service 直接堆复杂 SQL、shell、文件系统细节。
- 模块之间循环依赖。
- 新增超过 500 行的 service 或超过 200 行的 controller。
- 使用 `any` 逃避类型。
- 使用 `console.log`。
- 提交本机配置、密钥、缓存、构建产物。
- 在 runtime/tool 层绕过能力策略或 workspace 沙箱。
