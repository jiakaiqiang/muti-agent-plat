# Codex Handoff — 2026-08-10

## 背景

排查 `POST /api/local-runtime/workspaces/authorize` 响应慢问题，根因已定位，P1-2（索引排除规则不一致）已修复并提交（`89f8f7f`）。

当前还有三个待做项，状态如下：

---

## Task #3 (P1-3) — **进行中，90% 完成**

**目标：** CLI 端在 OS 弹窗真正弹出后，立即向服务器发送 `local_runtime.workspace.authorization.prompted` 消息；服务器记录 `promptedAt` 并打日志，不向前端暴露。

**已完成的改动：**

| 文件 | 改动 |
|------|------|
| `packages/shared/src/local-runtime-contracts.ts` | `LocalRuntimeClientMessage` 新增 `\| { kind: 'local_runtime.workspace.authorization.prompted'; payload: { requestId: UUID; promptedAt: ISODateTime } }` |
| `packages/local-runtime-cli/src/directory-picker.ts` | `PickerRunner` 类型新增第4参数 `onStarted?: () => void`；`defaultRunner` 改用 `execFile` callback 形式，`child.pid !== undefined` 时调用 `onStarted`；`selectWorkspaceDirectory` 新增第5参数 `onPrompted?: () => void` 并透传给 `run` |
| `packages/local-runtime-cli/src/transport.ts` | `authorization.request` 处理块，给 `selectWorkspaceDirectory` 传入第5参数，在 callback 里 `send({ kind: 'local_runtime.workspace.authorization.prompted', payload: { requestId, promptedAt: new Date().toISOString() } })` |
| `apps/server/src/modules/local-runtime/local-runtime-connection.service.ts` | `PendingWorkspaceAuthorization` type 新增 `promptedAt?: string`；`handleMessage` 在 `authorization.result` 之前新增分支处理 `authorization.prompted`，找到 pending 后设置 `pending.promptedAt` 并 `this.logger.log(...)` |

**已验证：**
- `packages/shared` typecheck ✅
- `packages/local-runtime-cli` typecheck ✅
- `apps/server` typecheck ✅

**尚未完成：**
- 运行 `local-runtime-cli` 的测试（命令格式问题未解决，见下方 Note）
- 需要补一个针对 `onPrompted` 的单元测试（在 `directory-picker.ts` 或 `transport.ts` 的 spec 文件中验证 `onStarted` 回调确实在进程启动后被调用）

**Note on test command：** 项目使用 Node built-in test runner + tsx。正确命令：
```bash
cd "D:/demo/muti-agent/muti-agent-plat"
node --import tsx/esm --test packages/local-runtime-cli/src/*.spec.ts
```
或查看 `packages/local-runtime-cli/package.json` 中的 `test` 脚本确认实际命令。

---

## Task #1 (P0) — **待做**

**目标：** 让用户能撤销已授权的工作区。用户选择"两个都加"：
1. CLI 命令 `remove-workspace <workspaceId>`
2. 服务器 HTTP 端点 `DELETE /api/local-runtime/workspaces/:workspaceId`

**关键文件：**
- `packages/local-runtime-cli/src/state.ts` — 需要新增 `removeWorkspace(state, workspaceId)` helper，过滤 `state.workspaces`，调 `saveState`，向服务器发送 `local_runtime.workspace.unregister`
- `packages/local-runtime-cli/src/transport.ts` — CLI 命令入口，或在 main CLI entry point 中注册子命令
- `apps/server/src/modules/local-runtime/local-runtime.controller.ts` — 新增 `@Delete('workspaces/:workspaceId')` 端点，调 `this.connections.unregisterWorkspace(workspaceId)`
- `apps/server/src/modules/local-runtime/local-runtime-connection.service.ts` — `unregisterWorkspace` 已存在（line ~769）：`unregisterWorkspace(client, workspaceId, reason)`，只需从 controller 调用

**注意：**
- CLI 已有 `local_runtime.workspace.unregister` 消息的发送能力（transport 中有处理，contracts 中有定义）
- 服务器已有 `handleMessage` 中处理 `workspace.unregister` 的分支（line ~511）
- 改完后端后需手动执行 `npm run dev:restart-server`（项目规则：后端 dev 不使用 watch）

---

## Task #2 (P1-1) — **待做**

**目标：** 减少 `state.json` 写入体积和频率。用户选择"拆到独立索引文件（推荐）"：
- 每个工作区的 `index.entries` 写到 `<workspaceId>-index.json`（与 `state.json` 同目录）
- `state.json` 中只保留索引元数据（不含 entries）
- `onIndexUpdated` 回调加 500ms 防抖（不改 `saveState` 本身，因为 `saveState` 还有其他调用方）
- 向后兼容：加载时若无独立文件则回退读 inline entries

**关键文件：**
- `packages/local-runtime-cli/src/state.ts` — 新增 `saveWorkspaceIndex(workspaceId, entries)` 和 `loadWorkspaceIndex(workspaceId)` 函数；`LocalWorkspaceState` 的 `index` 字段中 `entries` 改为可选；加载时合并
- `packages/local-runtime-cli/src/transport.ts` — line ~127-129 和 ~498，`onIndexUpdated` 回调处加 500ms debounce，同时触发写独立索引文件

**背景数据：**
- 当前 `state.json` 实测 4.28 MB（D:\demo 工作区 14546 个条目）
- stringify ~11ms，写入 ~10ms，每次索引增量更新都全量重写

---

## 通用约束（必须遵守）

- **后端改完必须手动重启**：`npm run dev:restart-server`（不要引入 watch/nodemon）
- **不要自动 git push**，需用户确认
- **不要删除用户数据/配置/密钥**
- **改动范围尽可能小**，不做无关重构
- `packages/shared/src/contracts.ts` 有用户未提交的改动，**不要 stage 或 revert**
- 未推送的提交：`89f8f7f`，待 `git push origin main`（之前两次因网络失败）

---

## 验证命令

```bash
# typecheck
node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/local-runtime-cli/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit

# 测试（先确认 package.json 中的 test 脚本）
npm run test -w @agent-cluster/local-runtime-cli

# 后端测试
npm run test -w @agent-cluster/server
```
