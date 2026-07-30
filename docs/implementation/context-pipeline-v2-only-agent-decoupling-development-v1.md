# Context Pipeline v2 单轨与 Agent 解耦开发实施文档 v1

> 日期：2026-07-12
> 状态：实现与空 v2 全链路验收已完成；真实数据切换待独立授权
> 上游需求：[`../product/context-pipeline-v2-only-session-requirements-v1.md`](../product/context-pipeline-v2-only-session-requirements-v1.md)
> 系统设计：[`../design/context-pipeline-v2-only-agent-decoupling-system-design-v1.md`](../design/context-pipeline-v2-only-agent-decoupling-system-design-v1.md)

## 1. Goal

- 将系统从部分 v2、部分旧 Runtime 选择语义收敛为唯一 v2 主链路。
- 从活动合同中移除 Agent Runtime/Model 字段。
- 让 `${skill:key}` 和 `${tool:key}` 编译结果真正进入 Invocation、Tool Catalog 和审计。
- 建立可 dry-run、可审计、幂等的“活动数据零保留 + 外部加密只读归档”cutover 流程。
- 完成 shared/server/web/Harness/contract/e2e 全链路验收。

## 2. Assumptions / constraints

- 所有当前 Session 和当前产品业务配置均视为旧数据，切换时删除并使用 v2 seed 重建。
- 不开发历史迁移、产品内归档、导出或 Resume；只生成活动根之外、无在线读取入口的加密只读审计归档。
- Runtime 模型连接和加密凭据属于运维配置，不在业务数据删除范围。
- 当前工作区已有大量用户修改和一组未完成的 v2 部分实现；实施时必须逐文件审查并保留无关改动。
- 历史数据删除、提交、部署分别需要独立授权。
- Cutover apply 不得在普通测试或服务启动中自动执行。

## 3. Research (current state)

### 3.1 Modules/subprojects involved

- Shared contracts：`packages/shared/src/contracts.ts`。
- Agent/Profile：`apps/server/src/modules/agents/`、`agent-profile/`、`skills/`、`capabilities/`、`tools/`。
- Orchestration：`apps/server/src/modules/orchestrator/`、`runtime-routing/`、`context-v2/`。
- Runtime：`apps/server/src/modules/runtimes/`。
- Workspace：`apps/server/src/modules/workspaces/` 和 Browser Broker 前端 stores。
- Session/Data：`sessions/`、`events/`、`tasks/`、`artifacts/`、`memory/`、`persistence/`、`recovery/`、`queue/`、`autopilot/`。
- Web：Agent 管理、Runtime Model 管理、Session 创建、Runtime/Debug 展示。

### 3.2 Current gaps

- `Agent`、`RuntimeAgentProfile`、`EngineeringRuntimeSelection` 仍混入 Runtime 字段。
- `selectEngineeringRuntime()` 在最终动态路由之前影响 preflight、事件和 Tool 注入。
- `availableToolsFor()` 只为 Generic LLM + server_local 返回 `read_file`。
- `CompiledAgentProfile.toolIds` 尚未成为真实 Tool Catalog 的权威输入。
- Invocation snapshot 没有完整 Skill revision、Tool Authority 和 target 分离审计。
- `PersistenceService` 只有通用 collection get/set，没有 maintenance transaction 和 schema epoch。
- Session 关联数据跨多个 collection、内存执行和 BullMQ Job。

### 3.3 Existing patterns to reuse

- `AgentProfileCompilerService` 的引用解析、诊断、hash 和预算逻辑。
- `ToolRegistryService`、`CAPABILITY_TOOL_MAPPING` 和 builtin Tool。
- `resolveExecutionTarget()` 的 eligible + fail-closed 结构。
- `ContextEnvelopeV2`、grounded evidence gate 和 Workspace Provider。
- `backfill-actor-ref.mjs` 的 dry-run/apply CLI 结构，但不复用其迁移语义。
- file persistence 临时文件写入与 PostgreSQL collection 表。

## 4. Analysis

### 4.1 Options

1. 在现有合同上继续标记 deprecated，并增加更多条件分支。
2. 引入 v2 新合同，保留旧合同适配器一段时间。
3. 一次性切换新合同并执行活动数据零保留 cutover。

### 4.2 Decision

采用方案 3。用户明确不保留任何历史兼容；方案 1 和 2 都会继续维护双语义，并妨碍 Agent 真正解耦。

### 4.3 Risks / edge cases

- 部分实现已经修改 shared 合同，继续开发前必须先修复当前 typecheck 基线。
- 旧 preflight 与最终 target 不一致可能绕过或错误阻断写权限。
- Tool Catalog 若只在 Prompt 展示，不能构成安全边界。
- Cutover 只清 `sessions` 会留下孤立事件、Artifact、Memory 和队列 Job。
- Artifact URI 可能指向用户 Workspace，不能递归删除。
- File backend 在 Windows 上替换失败时不得先删除旧 state。
- PostgreSQL 异步 collection write 必须在 cutover 前 drain，并在事务中重置。
- Runtime Adapter 不能强制 Tool Catalog 时必须判定不 eligible。

### 4.4 Open questions

无产品级开放问题。实际 cutover 环境、维护窗口、操作者和 confirm token 在执行前提供。

## 5. Q&A results

- 所有现有 Session 都是历史 Session。
- 历史 Session 不展示、不执行、不迁移、不导出、不恢复；外部加密归档只供获批的离线审计。
- 运行中历史 Session 统一取消，不重试、不 Resume。
- 历史产品业务数据在活动数据集中零保留，替换前生成外部加密只读归档。
- 所有活动合同使用新方式，不读取 deprecated Runtime 字段。
- Agent 必须与 Runtime/Model 真正解耦，并支持内部 Skill/Tool 引用和真实 Tool Catalog。

## 6. Architecture constraints

### 6.1 Allowed paths

- `packages/shared/src/`
- `apps/server/src/modules/{agents,agent-profile,skills,capabilities,tools,runtime-routing,orchestrator,context-v2,runtimes,workspaces,sessions,persistence,recovery,queue,autopilot,debug,ops}/`
- `apps/web/src/components/`、`apps/web/src/stores/`、`apps/web/src/types/`
- `scripts/`、`tests/e2e/`、`tests/harness-engineering/`
- `docs/{product,design,implementation,contracts,quality,devops,analysis,ai-agent-context}/`

### 6.2 Forbidden paths/actions

- 不修改 Harness Engineering 为业务功能。
- 不删除 Workspace 或用户源码文件。
- 不在测试、启动或 build 中自动执行 cutover apply。
- 不修改外部 Runtime 凭据或提交密钥。
- 不提交、推送、部署或执行真实数据删除，除非分别获得授权。

### 6.3 Invariants

- Agent identity 不含 target。
- Invocation target 不改变 Agent identity。
- Tool request 不等于 Tool grant。
- Runtime 启动前完成 route、Tool、Context 和 approval。
- 所有失败路径 fail closed。

## 7. Implementation plan

### 当前实施进度（2026-07-12）

- 已完成：Agent/Skill/Task/Session v2-only 合同、Profile 引用编译、Tool Authority、InvocationPlan、ContextEnvelope L0-L6、`invocationId`、单一任务验收决策。
- 已完成：Runtime 配置与 `enc-v2` 凭据、Adapter 单一 `start() -> AgentRuntimeRunHandle` 协议、Adapter 元数据驱动的动态路由、旧脚本和旧 E2E 清理。
- 已完成：file/PostgreSQL cutover dry-run/apply、外部加密只读归档能力及隔离测试；普通启动和测试不会自动 apply。
- 已完成：权威文档/Harness 全量同步、空 v2 状态主链路、单次/多次/浏览器 Context 补读验收，以及全量 typecheck/test/Harness/build。
- 待独立授权：真实数据 cutover apply。该操作不因本文档状态变更而自动获得授权。

### Phase 0：冻结基线与当前改动审计

目标：在继续开发前明确已有修改哪些可复用、哪些与最终设计冲突。

1. 保存当前 `git status` 和目标文件 diff 清单，不回退无关用户改动。
2. 运行 shared/server/web typecheck，记录当前失败基线。
3. 对照系统设计审查已修改的 Context v2、路由、Workspace、密钥和文档代码。
4. 删除或改写仅服务 v1 兼容的新增测试，不触碰无关历史任务文档。

完成标准：形成目标文件清单，typecheck 失败均已归属到后续 Phase。

### Phase 1：Shared 合同一次性切换

主要文件：`packages/shared/src/contracts.ts`、shared contract tests 和 mock fixtures。

1. 用 `AgentDefinition` 替换活动 `Agent` Runtime 字段语义。
2. 新增 `CompiledAgentIdentity`、`ResolvedToolCatalog`、`InvocationPlan`、`SystemDataMetadata`。
3. 扩展 `ResolvedExecutionTarget.requiredToolIds/workspaceProviderKind`。
4. `ContextEnvelopeV2`、target、catalog 改为 Invocation 必填。
5. 删除 `EngineeringRuntimeSelection`、Agent override、旧 `RuntimeAgentProfile` 字段和 v1 version union。
6. Session 使用 `runtimePreference`，删除旧创建请求字段。

测试：合同 exact-type、禁止旧字段、序列化 shape、mock fixture。

### Phase 2：Agent Profile Compiler 收敛

主要文件：`modules/agent-profile/`、`modules/agents/`、`modules/skills/`、`modules/capabilities/`。

1. Compiler 输出完整 Skill binding hash/revision 和 requested Tool。
2. Agent create/update 只接受 Profile、Capability 和知识绑定。
3. 保存时 diagnostics 有 error 则拒绝。
4. Invocation 前按当前资源 revision 重编译并形成不可变 identity。
5. 删除 `skillIds` 双写、Agent runtime/model normalize 和 backfill。
6. 默认 Agent seed 改为新合同。

测试：引用、转义、代码块、重复、状态、权限、revision、缓存失效、预算。

### Phase 3：Tool Authority 与真实 Catalog

建议新增：`modules/tools/tool-authority-resolver.service.ts` 和 `resolved-tool-catalog.ts`。

1. 统一 Tool Definition、Registry name 和 Capability mapping。
2. 实现 request/grant/phase/workspace/runtime/approval 六层交集。
3. 为 allowed/blocked Tool 生成可审计 decision。
4. 让 Generic LLM 工具循环消费 Catalog。
5. 为 Codex/Claude 定义 Catalog 翻译和可强制性检查。
6. 删除 Orchestrator `availableToolsFor()` 硬编码。

测试：每层拒绝、Catalog hash、顺序稳定、Adapter 不支持、审批过期、高风险 Tool。

### Phase 4：Invocation Resolver 与动态路由

主要文件：`modules/runtime-routing/`、`modules/orchestrator/orchestrator.service.ts`、`modules/runtimes/runtime.service.ts`。

1. 新增统一 `InvocationResolverService`。
2. 从 Task/Phase/Workspace/Profile Tool requirements 生成 routing input。
3. 只按 task/session/project/smart/global 优先级选择 eligible Runtime。
4. 删除 Agent preference、`selectEngineeringRuntime()` 和 `pairAgentWithExecutionTarget()`。
5. 在 target/catalog/context/preflight 完成后才 emit `runtime_started`。
6. Runtime invocation snapshot 分开记录 identity、catalog 和 target。

测试：动态选择、无 eligible、浏览器降级、最终事件一致、Agent 字段无法影响 target。

### Phase 5：Context v2 和 Runtime Adapter 输入

主要文件：`modules/context-v2/`、`common/token.ts`、Codex/Claude/Generic/Mock Adapter。

1. Runtime 输入改为 `InvocationPlan`。
2. `ContextEnvelopeV2` 必填，在组装阶段分配分层预算并保留 grounded L3 Evidence。
3. 删除 Runtime-facing 旧 Workspace payload 和 `runtimeSelection`。
4. L0/L5 写入 identity/catalog/target refs。
5. Evidence gate 在 Runtime 启动前执行。
6. 严格校验补读请求，记录 hydrated/failed/deferred，只有成功路径进入 Evidence 和 dedupe；补读后重新解析整份 Invocation。

测试：L0-L6、无重复 payload、token trimming、grounded evidence、补读重算 target/catalog。

### Phase 6：API、Debug 和 Web

1. Agent API 删除 runtime/model/skillIds 输入。
2. Session API 接受可选 `runtimePreference`，拒绝旧字段。
3. Health 增加 data schema/epoch，删除 feature flag 语义。
4. Debug 分栏展示 identity、Skill、Tool Authority、target 和 Envelope。
5. Agent 管理支持 Skill/Tool 插入和 diagnostics。
6. Runtime Model 管理移除 Agent 编辑职责。
7. Session/Runtime UI 不显示历史 Session 或 Agent 固有 Runtime。

测试：controller/store/component，旧请求字段拒绝，页面最长文本和空态。

### Phase 7：Persistence Maintenance 与 Cutover CLI

主要文件：`modules/persistence/`、`modules/execution/`、`queue/`、`recovery/`、`autopilot/` 和 `scripts/cutover-context-v2.mjs`。

1. 新增 `SystemDataMetadata` 读取和 `CUTOVER_REQUIRED` 启动门禁。
2. 实现只读 inventory 和关联完整性检查。
3. 实现 maintenance mode：停写、取消执行、暂停队列、关闭 Browser Broker lease。
4. apply 先在活动数据根之外原子写入 AES-256-GCM 加密只读归档和 manifest，失败时不替换活动 state。
5. File backend 生成并原子切换空 v2 state。
6. PostgreSQL backend 单事务重置 collection rows。
7. 重置业务配置并 seed v2 defaults。
8. 删除平台数据根目录内 Artifact，拒绝 Workspace/外部 URI。
9. 生成包含归档 hash/bytes 的最小 cutover audit 和新 dataEpoch。
10. apply 使用 dry-run token + revision + 环境绑定。

测试：dry-run 零写入、stale token、幂等、文件替换失败、PG rollback、Artifact path guard、并发新 Session 拒绝。

### Phase 8：旧语义删除与全仓同步

1. `rg` 清理 v1 flag、Agent Runtime 字段、override、backfill、兼容注释和测试。
2. 更新 API/data/runtime/UI/Harness 合同。
3. 更新功能状态、开发运维、发布清单和项目地图。
4. 删除或替换 v1/v2 isolation E2E。

完成标准：活动代码和权威文档中不存在旧语义。

### Phase 9：本地空数据验收

1. 使用隔离 file data 执行 dry-run 和 apply。
2. 启动 v2-only server，验证新 dataEpoch。
3. 创建新 Agent、Skill/Tool 引用和新 Session。
4. 完成讨论、Brief、执行、Review、Delivery。
5. 对同一 Agent 使用两个 eligible Runtime，验证 identity hash 不变。
6. 验证旧数据、旧队列和旧 Browser Broker 不能恢复。

该阶段只使用隔离测试数据，不操作用户当前数据。

### Phase 10：真实环境 Cutover（独立授权）

1. 确认目标 backend、数据位置、commit 和维护窗口。
2. 进入维护模式并禁止新 Session。
3. 执行 dry-run，人工审查范围和活动执行清理结果。
4. 用户明确确认本次活动数据切换、外部只读归档和旧会话不可恢复。
5. 使用一次性 token 执行 apply。
6. 验证归档 manifest/hash、dataEpoch、空活动业务数据、默认 seed 和 Health。
7. 启动服务并创建一条新 v2 Session 做 smoke。

没有第 4 步确认，不执行 Phase 10 apply。

## 8. Cross-module coordination

```text
Shared contracts
  -> Agent/Profile + Tool Authority
  -> Invocation Resolver + Context v2
  -> Runtime Adapters
  -> API/Web
  -> Cutover Tool
  -> E2E/Harness/Docs
```

合同修改必须先落 shared tests，再改 server，最后改 web。Cutover 工具只能在新合同和新 seed 稳定后开发完成，真实 apply 最后执行。

## 9. Tests to run

### 9.1 Focused tests

```powershell
node node_modules/tsx/dist/cli.mjs --test packages/shared/src/*decoupling*.test.ts
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/agent-profile/*.spec.ts
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/tools/*.spec.ts
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/runtime-routing/*.spec.ts
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/context-v2/*.spec.ts
node node_modules/tsx/dist/cli.mjs --test scripts/cutover-context-v2.spec.mjs
```

### 9.2 E2E

建议新增：

```text
npm run test:e2e:agent-runtime-decoupling
npm run test:e2e:profile-skill-tool-catalog
npm run test:e2e:context-pipeline-v2-only
npm run test:e2e:cutover-file
npm run test:e2e:cutover-postgres
npm run test:e2e:data-epoch-isolation
```

继续运行：

```text
npm run test:e2e:main-chain
npm run test:e2e:dynamic-runtime-routing-audit
npm run test:e2e:local-runtime-requested-paths-supplement
npm run test:e2e:security
```

### 9.3 Full gates

```text
npm run typecheck
npm run test
npm run test:harness
npm run build
```

真实 Codex/Claude/GLM 验收继续使用现有显式环境 gate，不因本改造自动产生外部调用或成本。

## 10. Definition of done

- 需求 R-01～R-08 均有代码、合同和自动化证据。
- Agent 和 Runtime/Model 在活动合同中结构性分离。
- Skill/Tool 引用生成真实 Invocation 快照和 Tool Catalog。
- 所有 Runtime Adapter 遵守相同权限边界。
- ContextEnvelopeV2 是唯一 Runtime context。
- v1、override、固化 target 和历史 fallback 从活动代码删除。
- 隔离 file/PostgreSQL cutover 测试通过。
- 全量质量门通过。
- 真实数据 apply 尚未执行时，交付必须明确标记“待独立授权”。

## 11. Delivery artifacts

- 更新后的 shared/API/data/runtime/UI 合同。
- Agent/Profile/Tool/Invocation/Cutover 单元和 E2E 报告。
- file/PostgreSQL 隔离 cutover 验证报告。
- `rg` 旧语义清理报告。
- 全量 typecheck/test/Harness/build 报告。
- 真实 cutover dry-run 报告和最小审计摘要（仅在获授权后生成）。
