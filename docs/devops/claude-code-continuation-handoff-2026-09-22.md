# Claude Code 接续开发交接记录

更新时间：2026-09-22（Asia/Shanghai）  
仓库：`D:\demo\muti-agent\muti-agent-plat`  
目的：让后续 Claude Code 代理在不重置现有工作树、不重复已完成验证的前提下继续开发。

## 先读的约束

1. 先读根目录 `AGENTS.md`，再读：
   - `docs/ai-agent-context/README.md`
   - `docs/ai-agent-context/project-map.md`
   - `docs/ai-agent-context/harness-engineering-protocol.md`
2. 当前工作树很脏，包含大量既有功能和文档改动。不要执行 `git reset --hard`、批量清理未跟踪文件或覆盖其他模块；先用 `git status --short`、`git diff --name-only` 建立基线。
3. 提交、发布、部署、外部数据库写入、真实模型调用和 DingTalk 操作都不在本交接授权内；需要时先向用户确认。
4. 不要把 Harness Engineering 当成产品功能。代码实现必须以产品合同、设计、任务和验收文档为依据。

## 已完成

### 本轮已完成的开发闭环

- 在 `apps/server/src/modules/workflows/workflow-runtime.service.ts` 中，工作流 Agent/Robot 节点创建任务后补发幂等的 `task_created` 和 `task_assigned` 事件。
  - 事件通过 `events.createOnce` 写入，按任务 ID 去重。
  - 事件携带 Coordinator、assignee、eligible agents、routing mode、workflow run/node 信息和任务卡 payload。
  - Agent 与 Robot 两条创建路径均接入。
- 在 `apps/server/src/modules/workflows/workflow-runtime.service.spec.ts` 中增加回归断言，确认工作流任务创建后事件顺序为 `task_created → task_assigned`，并确认接收 Agent。
- 修正 `tests/e2e/session-agent-isolation-smoke.mjs`：公开 chat surface 只传入 `requirements`，内部 Coordinator 不作为公开参与者；校验事件时动态读取 Coordinator 的真实 UUID，允许其作为受信任内部事件作者。
- 修正 `tests/e2e/coordinator-controlled-routing-smoke.mjs`：
  - 为每个场景创建隔离的 `server_local` 临时工作区，避免工作目录前置条件造成误失败。
  - 将旧的“通用自动重新分配”断言改为当前工作流绑定任务的 fail-closed 语义：Agent 拒绝后任务阻塞，发出 `workflow_agent_substitution` 的用户确认，并保留候选 Agent；不允许伪造子 Agent 重分配。
  - 保留“全部候选拒绝后进入用户决策”的负向场景。

### 已同步的文档

- `docs/quality/group-chat-attachment-skill-agent-t14-acceptance-checklist-v1.md`：两条专项 E2E 改为 passed，外部依赖仍为 pending。
- `docs/implementation/group-chat-attachment-skill-agent-t14-acceptance-task-v1.md`：补充本轮聚焦验证证据。
- `docs/roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md`：GC-14 状态改为“专项夹具已补跑，外部依赖 pending”。

### 当前已取得的验证证据

以下命令在 Windows PowerShell、mock Runtime、file persistence 环境通过：

```text
npm run typecheck -w @agent-cluster/server
node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/workflows/workflow-runtime.service.spec.ts
node --check tests/e2e/coordinator-controlled-routing-smoke.mjs
npm run test:e2e:session-agent-isolation
npm run test:e2e:coordinator-controlled-routing
git diff --check
```

其中 WorkflowRuntime 单测为 32/32；两条专项 E2E 的进程退出码均为 0，并输出各自的 `... smoke ok`。此前 GC-14 基线还记录过全局 `typecheck`、`test`、`test:harness`、`build` 通过，Server 1701 项（1684 通过、17 跳过），Web 350 项，开发监督 37 项，桌面 13 项；若继续修改核心代码，应重新执行相应门禁。

## 正在进行 / 当前工作状态

- 当前交接目标是把 GC-14 本地可复现闭环交给 Claude Code 继续维护；本轮代码和证据已完成，没有遗留一个正在运行的命令或后台服务。
- 工作树仍是未提交状态，且包含本轮以外的大量用户改动。不能依据整体 `git diff` 推断所有变更都由本轮产生。
- 长任务目标仍保持 active，等待后续代理或用户确认更大范围目标是否达成；不要因为本文件生成就擅自提交、发布或标记整个项目完成。

## 尚未完成 / 明确保持 pending

这些项目在当前环境没有被伪造为通过，后续代理应按前置条件逐项处理：

1. 真实多模态/付费模型验收（需要真实凭据、预算和用户授权）。
2. 外部 PostgreSQL 实例、跨进程迁移/恢复等外部基础设施验收（需要明确数据库连接和写入授权）。
3. Windows 原生桌面缩放、真实 GUI/双端交互验收（需要可操作的桌面环境）。
4. 发布前完整 release/preflight、部署和提交尚未执行；本交接不包含 commit、push、PR 或 deploy。
5. 仓库中其他路线图/阶段的未完成项不能由 GC-14 的 passed 推断为已完成；以对应四件套和测试结果为准。

## Claude Code 推荐接续顺序

### 第一步：重建安全基线

```powershell
git status --short
git diff --name-only
Get-Content -Raw AGENTS.md
Get-Content -Raw docs/ai-agent-context/project-map.md
```

确认没有用户新指令后，再进入下一步；不要清理工作树。

### 第二步：重跑最小门禁

```powershell
npm run typecheck -w @agent-cluster/server
node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/workflows/workflow-runtime.service.spec.ts
npm run test:e2e:session-agent-isolation
npm run test:e2e:coordinator-controlled-routing
npm run test:harness
```

若出现 `spawn EPERM`，这是本机沙箱/进程权限问题；不要修改业务断言来规避，改用当前环境允许的受控权限重跑并记录原因。

### 第三步：再处理外部验收

先检查 `.env.example`、`docs/devops/local-development.md` 和对应 Phase 6 文档，确认凭据、数据库、桌面和预算条件；任何真实模型调用、外部数据库写入、部署或通知动作都必须先向用户确认。

### 第四步：每次行为变更同步四件套

如果继续修改 GC-14 或其依赖功能，至少同步对应的 product/design/implementation/quality 文档，并在这里追加日期、代码路径、命令和真实结果。不要把“已创建文档”写成“功能已实现”。

## 交接完成判定

只有同时满足以下条件，Claude Code 才可以把本交接批次标为完成：

- 本文件中的 focused tests 仍全部通过；
- 任何新增行为都有对应单测或 E2E；
- 外部依赖仍逐项标记真实状态，没有用 mock 结果替代；
- 工作树未被无授权清理，提交/发布动作得到用户明确确认；
- `docs/quality/group-chat-attachment-skill-agent-t14-acceptance-checklist-v1.md` 与实际证据一致。

## 关键入口

- WorkflowRuntime：`apps/server/src/modules/workflows/workflow-runtime.service.ts`
- WorkflowRuntime 单测：`apps/server/src/modules/workflows/workflow-runtime.service.spec.ts`
- Session Agent 隔离 E2E：`tests/e2e/session-agent-isolation-smoke.mjs`
- Coordinator 路由 E2E：`tests/e2e/coordinator-controlled-routing-smoke.mjs`
- GC-14 验收清单：`docs/quality/group-chat-attachment-skill-agent-t14-acceptance-checklist-v1.md`
- GC-14 Task：`docs/implementation/group-chat-attachment-skill-agent-t14-acceptance-task-v1.md`

