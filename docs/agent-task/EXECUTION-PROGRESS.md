# Agent Task 当前执行进度

- 更新时间：2026-07-11
- 任务总数：142
- 已完成：90（T01–T90，约 63.4%）
- 当前任务：T91 `Browser Workspace Broker 阶段起点`
- 待执行：52（T91–T142）
- 执行原则：严格按任务编号顺序执行；当前任务完成并更新完成记录后，才能读取和实施下一任务。

## 阶段进度

| 阶段 | 范围 | 状态 | 说明 |
|---|---:|---|---|
| A | T01–T06 | completed | 版本基线与合同已完成 |
| B | T07–T14 | completed | 紧急扫描修复已完成 |
| C | T15–T20 | completed | 意图与任务语义已完成 |
| D | T21–T29 | completed | Token 与 Context 紧急修复已完成 |
| E | T30–T37 | completed | 严格 Runtime Artifact 已完成 |
| F | T38–T44 | completed | 任务状态与 Post Review 已完成 |
| G | T45–T52 | completed | 全部 Workspace Plane 合同（Provider Kind/Capability/Op/Revision/ChangeSet/Conflict/Provider 接口/Registry）已完成 |
| H | T53–T60 | completed | ServerLocal Provider 路径归一化/list/stat/read/search/ChangeSet 校验与应用/写入后 revision 全部完成 |
| I | T61–T68 | completed | WorkspaceIndex 合同/构建/生成与敏感标记/入口推导/测试关联/revision 敏感缓存/多 workspaceId 索引服务全部完成 |
| J | T69–T80 | completed | Context Pipeline v2 全套：Envelope 合同/阶段策略/Navigation/ProjectMap/Evidence 评分-去重-预算-补读/Pack Builder/Duplicate 校验/Grounded Gate/Debug Presenter 全部完成 |
| K | T81–T90 | completed | 动态 Runtime 路由：Routing 输入合同/架构&编码候选/ExecutionTarget resolver/Agent Profile 恒身份/Workspace 工具适配/Codex&Claude 精简 Context/Browser 降级与命令阻塞 全部完成 |
| L | T91–T108 | in progress | T91 待启动 |
| M–O | T109–T142 | pending | 尚未开始 |

## 最近完成内容

### T44 确认动作分流

- 前端 `SessionWorkspace` 已按结构化 Post Review action 调用专用 API，不再把四个选项统一映射为 resume。
- 服务端已分别处理补读工作区、受限交付、保存进度和取消流程。
- 已记录的验证包括：前端相关测试 2/2、服务端 Sessions/Orchestrator 组合测试 19/19、server typecheck、web `vue-tsc` 和相关 `git diff --check`。

### T45–T50 Workspace Plane 合同

- T45：定义 `server_local`、`browser_broker`、`local_bridge` 三种 `WorkspaceProviderKind`。
- T46：定义 `read`、`write`、`command`、`test` 四项 `WorkspaceCapabilities`。
- T47：定义 list、stat、read、search 的输入输出合同。
- T48：定义 `WorkspaceRevision`、SHA-256 `FileHash`，并把 revision/hash 接入操作结果。
- T49：定义 create、update、delete、move 的 `WorkspaceChangeSet` 判别联合。
- T50：定义 `WORKSPACE_BASE_HASH_MISMATCH` 和结构化 `WorkspaceConflictError`。
- 每个任务均先建立失败合同测试，再实现合同，并已在各任务文件的“完成记录”中登记验证结果。

### T51 WorkspaceProvider 接口

- 在 `packages/shared/src/contracts.ts` 增加 `ApplyChangeSetResult` 判别联合，覆盖 `ok:true` 成功（`changeSetId`/`revision`/`appliedCount`）与 `ok:false` 冲突（`conflicts: WorkspaceConflictError[]`）两种返回形态。
- 新增 `apps/server/src/modules/workspaces/workspace-provider.ts`，`WorkspaceProvider` 接口暴露 `kind` 与 7 个方法签名，全部复用 T45–T50 的共享类型。
- 验证：shared/server typecheck 通过，`workspace-provider.contract.spec.ts` 1/1 通过。

### T52 Workspace Provider Registry

- 新增 `apps/server/src/modules/workspaces/workspace-provider-registry.ts`，`WorkspaceProviderRegistry` 提供 `register`/`resolve`/`has` 三个方法。
- 重复注册与解析未注册 `WorkspaceProviderKind` 均抛出可诊断错误，避免 Provider 被静默替换或空引用。
- 验证：shared/server typecheck 通过，`workspace-provider-registry.spec.ts` 3/3 通过。

## 当前断点：T53

任务文件：[053-T53.md](./053-T53.md)

目标是实现工作区根目录内的安全路径解析（server-local 路径归一化），拒绝绝对路径与 `../` 越界访问；实施范围为 `apps/server/src/modules/workspaces` 与 `apps/server/src/common/server-file-changes.ts`。

## 当前验证结果

2026-07-11 T52 完成后：

```text
npm run typecheck --workspace=@agent-cluster/shared
结果：通过
```

```text
npm run typecheck --workspace=@agent-cluster/server
结果：通过
```

```text
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/workspaces/workspace-provider-registry.spec.ts
结果：3/3 通过
```

## 下一步恢复顺序

1. 读取 `053-T53.md` 与现有 `apps/server/src/common/server-file-changes.ts` 的路径处理逻辑。
2. 先补失败测试：绝对路径、`..` 越界、符号链接类绝对路径、空段、Windows 路径分隔符等场景应被拒绝，安全路径应解析到工作区根目录内。
3. 实现路径归一化工具（例如 `resolveWorkspacePath` 或在 workspaces 模块新增 helper），保持与 T51 接口协议一致。
4. 运行 server typecheck 与 path safety 单测直至绿灯。
5. 完成后把 `053-T53.md` 完成记录填齐，再读取并执行 T54。

## 工作区注意事项

- 当前工作区存在较多未提交和未跟踪变更，其中包含本轮及此前任务成果；继续执行时必须保留这些变更，不得清理或覆盖无关内容。
- `docs/agent-task` 当前在 Git 状态中整体显示为未跟踪目录；任务完成状态以目录内文件的当前内容为准。
- 尚未执行提交、发布、部署或真实外部 Runtime 操作。
