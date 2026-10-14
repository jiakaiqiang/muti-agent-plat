# GitHub 会话代码交付 Plan v1

状态：2026-09-28 按 Tasks 实施中；代码已有阶段性实现，完整验收未完成。

依据：[Spec](../product/github-session-delivery-spec-v1.md) | [Tasks](../implementation/github-session-delivery-tasks-v1.md) | [Checklist](../quality/github-session-delivery-checklist-v1.md)。

## 1. 现状与方案选择

- `SessionWorkingDirectory` 只有 `local_bridge | server_local`；`SessionsService.create` 绑定现有目录后立即调用 `generateBriefInBackground`。
- 服务器 `WorktreeExecutionService` 已按会话/任务隔离，但捕获结果为 UTF-8 `WorkspaceChangeSet`；二进制与非 UTF-8 改动当前失败。
- 本机 Local Runtime 为每次调用复制临时目录，排除 `.git`，再用 ChangeSet 写回；该路径不能直接完成 GitHub 分支提交。
- `WorkspaceWritebackService` 已有持久冲突记录与串行写回，但冲突界面没有逐文件结果编辑。
- 服务端有 `secret-cipher`，本机有 Windows DPAPI `LocalSecretStore`；通知中心目前从当前会话事件投影。
- Session `ownerId` 当前固定为 `local-user`。首版仍按单用户部署，不能把它当成可区分多个真人的授权依据。

选择“代码来源适配器 + 执行设备侧 Git 工作区 + 独立交付状态机”。继续复用 Workspace Provider、Agent 编排、事件与持久化基础，不把 GitHub 伪装为新 Runtime，也不让普通目录模式自动推送。

## 2. 架构边界

```text
Web / Desktop
  -> SessionsService / SourcePreparationCoordinator
  -> CodeHostAdapter (GitHub v1)
  -> RepositoryWorkspaceManager (Local Runtime 或 Server)
  -> 现有 Workspace Provider / Agent 编排
  -> DeliveryCoordinator / ValidationGate
  -> ConflictService / NotificationChannel
```

| 组件 | 职责 | 主要落点 |
| --- | --- | --- |
| `SourcePreparationCoordinator` | 授权、克隆、选分支、绑定工作区后放行 Agent；重启恢复 | `apps/server/src/modules/sessions/`、新增 `code-sources/` |
| `CodeHostAdapter` | 托管平台身份、仓库权限、分支/PR/CI/Diff/合并；仅 GitHub 实现 | 新增 `apps/server/src/modules/code-hosts/` 与本机同构操作合同 |
| `RepositoryWorkspaceManager` | 缓存拉取、会话 Worktree、远端任务分支整合、清理 | 新增 `apps/server/src/modules/repository-workspaces/`、`packages/local-runtime-cli/src/` |
| `DeliveryCoordinator` | 验证、提交、推送、PR 生命周期、幂等和恢复 | 新增 `apps/server/src/modules/delivery/` |
| `ConflictService` | 将 Git 冲突和现有写回冲突投影为统一编辑模型；保存结果、校验、恢复 | 新增 `apps/server/src/modules/conflicts/`，接入 `workspaces/` |
| `NotificationChannel` | 站内通知投影；以后增加其他渠道 | `events/`、Web 通知中心及新适配接口 |

允许修改范围：相关 shared 合同、sessions、workspaces、worktree-execution、local-runtime、orchestrator 的交付入口、persistence/events、Web/Desktop 会话与 Diff UI、对应测试和合同文档。禁止改变无关 Agent 身份、Tool Authority、普通本地目录自动写回语义，以及现有 Harness 工程规程。

## 3. 合同与数据模型

`SessionCodeSource` 与 `SessionWorkingDirectory` 分离。前者在创建时记录用户选择，后者在 GitHub 准备完成后由系统生成并绑定。

```ts
type SessionCodeSource =
  | { kind: 'local_directory' }
  | { kind: 'remote_repository'; provider: 'github'; repositoryUrl: string; deviceId?: string };

type SourcePreparationState =
  | 'awaiting_auth' | 'cloning' | 'awaiting_base_branch' | 'binding'
  | 'ready' | 'blocked' | 'failed';

type DeliveryState =
  | 'idle' | 'awaiting_validation_input' | 'validating' | 'needs_fix'
  | 'preparing_push' | 'resolving_conflict' | 'pushing' | 'pr_open'
  | 'awaiting_ci' | 'merge_ready' | 'merging' | 'merged' | 'blocked';
```

- `SourceBinding`：`sessionId`、规范化 `github.com/{owner}/{repo}`、仓库稳定 ID、授权引用、执行位置/设备、缓存键、独立工作区 ID、基础分支/选定 SHA、状态、版本与错误码。
- `CredentialRecord`：授权类型、GitHub 账户、仓库权限摘要、执行设备、加密秘密引用、有效性；服务端和本机各自持有自己的秘密，不随 Session 删除。
- `DeliveryRecord`：`sessionId`、交付轮次、任务分支、提交 SHA、PR 编号/URL、目标分支、验证记录、CI 摘要、用户审查的 head SHA、合并提交 SHA、状态与操作幂等键。
- `ConflictRecord`：冲突来源、目标操作、base/ours/theirs Git 对象或受控内容引用、全部文件的类型和状态、用户草稿、版本、解决提交 SHA。文件内容按需分页读取，不把大文件塞入 Session JSON 或事件。
- file backend 与 PostgreSQL 均保存上述状态；迁移先具备读取新字段能力，再开放新建入口。密钥正文不得落在 Session、事件、Artifact 或普通日志。

会话的 `SessionStatus` 只承载“等待准备/用户动作/执行”的总状态；PR 可在 Session 已完成后继续处于待合并状态。因此以独立 `DeliveryState` 为交付权威状态。`generateBriefInBackground` 及所有重试/恢复入口统一校验 `SourcePreparationState === ready`，不能只在创建 UI 阻止。

## 4. 设备侧工作区与凭据

1. 将 GitHub URL 规范化为稳定仓库身份，只允许 `github.com`，拒绝任意主机、URL 内凭据、危险重定向。首版 Git 操作使用 HTTPS 授权。
2. GitHub 授权页采用 GitHub App 的用户授权流程；App 需安装到目标仓库，并验证用户与 App 的实际权限。PAT 作为同等入口。OAuth 回调使用一次性 `state` 和会话/设备绑定。对本机执行，后端仅作短暂安全转交，收到本机加密存储确认后清除临时令牌；后续 GitHub API 与 Git 操作由本机执行。服务端执行使用现有密钥加密原语持久化。
3. 令牌只通过专用输入/协议传输，不在 Git 远端 URL、进程参数、错误文本或 `runGit` 日志中出现。Git 子进程使用受控凭据输入方式；禁用不受控凭据提示。
4. 缓存按仓库稳定 ID、授权主体和执行位置分区，串行更新同一缓存。缓存不承载工作区改动；每个会话分配独立工作区及唯一 `workspaceId`，避免现有 Workspace Session lease 冲突。
5. GitHub 任务在会话 Worktree 的任务级隔离副本中执行，保留 `.git` 能力并以 Git 对象/候选提交记录结果。服务器已有 Worktree 路径和本机临时复制路径需增加 GitHub 专用分支；普通本地目录继续使用原 ChangeSet 路径。
6. 对受控候选生成显式提交清单，排除会话源目录中的平台外修改。删除会话先停止调用，再删除会话独立工作区和冲突草稿，不删除缓存、授权和远端分支。

GitHub App 对 Git HTTP 访问需要适当的仓库 Contents 权限，实际能力取 App 与用户权限的交集；权限预检和出错反馈必须基于真实操作结果，而不只依赖授权成功。[GitHub 官方说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)。

## 5. 状态流与操作

```text
会话创建 -> awaiting_auth -> cloning -> awaiting_base_branch -> binding -> ready
ready -> Agent 执行 -> validating -> preparing_push -> pushing -> pr_open
pr_open -> awaiting_ci / merge_ready -> 用户点击合并 -> merging -> merged
                                  -> resolving_conflict -> validating -> pushing -> awaiting_ci
```

- 创建会话先持久化任务消息和来源选择，再进入准备流程；`ready` 前不产生 Agent Invocation。失败保持可重试状态，不隐式回退为服务器任意目录。
- 基础分支在准备时取得当前 SHA；Agent 执行期间不自动更新。每次交付轮次使用原基础分支名，PR 创建/合并时重新检查远端状态。
- 平台验证由结构化仓库清单检测器给出候选命令，由平台执行并保存退出码、耗时、输出摘要和候选提交 SHA；Agent 文字报告仅作建议。没有可靠命令转 `awaiting_validation_input`。每次候选、任务分支整合或冲突解决后都重新验证。
- 推送前先查询远端任务分支。如果其 head 前进，则在隔离 Git 工作区整合；冲突进入 `ConflictRecord`，不得强推覆盖远端。推送成功后对账原 PR 状态：open 则更新，closed 未合并则尝试重开，merged 则开启新轮次。
- 站内事件和交付记录采用稳定操作 ID，先持久化状态/待发布事件，再执行或确认远端副作用。超时重试先查询 GitHub 分支和 PR，不盲目再次创建。
- 合并按钮从服务端最新快照得出：本机设备在线且心跳新鲜、平台验证对应当前 head、配置的 CI 均通过或根本未配置、PR open 且用户可操作。点击时传 `expectedHeadSha`，再次查远端并调用 Squash Merge；GitHub `mergeable=null` 时等待查询结果，head 变化时要求刷新而不是合并未审查代码。[GitHub PR 接口](https://docs.github.com/en/rest/pulls/pulls)。
- 若当前基础分支与任务分支冲突，合并操作转冲突编辑。用户解决后把目标分支合入任务分支，验证通过、推送并等待 CI；按钮再次出现。处理期间不轮询并重排新的基础分支提交，最终 GitHub 拒绝时才重新进入冲突流程。
- 成功后以 GitHub 返回的 Squash commit SHA 查询实际提交与差异，不把合并前 PR 预览当成最终合入证据。

## 6. 冲突编辑器设计

统一只读 `ConflictView` 投影：文件列表、冲突类型、base/ours/theirs 版本、三栏结果、冲突块和状态版本。Git 冲突优先读取 index stage 1/2/3 或 Git 对象；现有 WorkspaceWriteback 的 base/current/candidate 映射到相同视图，但沿用自身写回事务。

- 文本文件：左右对比、第三栏可编辑、颜色区分冲突/非冲突，支持键盘选择 ours/theirs、撤销、保存草稿；结果提交前检查未解决标记和文件版本。
- 二进制、删除/改名、文件模式：使用类型化决策控件；不以文本编辑器打开二进制。支持逐文件确认和 Agent 建议，但建议不能自动完成确认。
- 草稿按 conflictId/fileId/expectedVersion 保存。刷新与断线后恢复；过期版本返回 409 并保留用户草稿供重新比对。
- 完成冲突解决后先写受控工作区、生成解决候选、执行验证；失败时保留结果和当前会话，不提交或推送。
- Web 与 Desktop 共用数据合同与交互逻辑；编辑组件独立于现有只读 Historical Diff。所有可处理冲突均从同一入口进入。

## 7. API 与消息合同草案

| 操作 | 建议入口 | 幂等/并发条件 |
| --- | --- | --- |
| 创建会话 | `POST /sessions` 增加 `codeSource` | 一会话一来源；不接受用户提供的服务器工作区路径用于 GitHub 模式 |
| 授权 | `POST /code-hosts/github/oauth/start`、回调、`POST /code-hosts/github/tokens`、`DELETE /code-hosts/github/authorizations/:id` | OAuth state、设备绑定、令牌专用输入 |
| 选基础分支 | `GET /sessions/:id/source/branches`、`POST /sessions/:id/source/base-branch` | expectedSourceVersion；ready 后不可改变 |
| 交付与差异 | `GET /sessions/:id/delivery`、`GET /sessions/:id/delivery/diff` | 与当前 PR head 对应，分页与大小限制 |
| 冲突编辑 | `GET /sessions/:id/conflicts/:id`、`PUT /sessions/:id/conflicts/:id/files/:fileId`、`POST /sessions/:id/conflicts/:id/complete` | expectedConflictVersion、内容大小与敏感路径校验 |
| 用户合并 | `POST /sessions/:id/delivery/merge` | Idempotency-Key、expectedHeadSha、服务端操作人校验 |

Local Runtime 新增对应的有类型请求/结果：`repository.prepare`、`repository.branches`、`repository.integrate`、`repository.validate`、`repository.publish`、`repository.conflict.*`、`repository.merge`、`repository.cleanup`。每条消息绑定 sessionId、deviceId、workspaceId、operationId 和超时；不提供任意 Git shell 命令 API。

## 8. 风险、兼容与发布

- 单用户身份：当前 `ownerId='local-user'` 不能区分多个真人。首版部署必须有单用户访问边界；后续多人场景需另做平台身份与授权，不将 GitHub token 误当平台登录。
- 二进制与大文件：现有 ChangeSet 只支持 UTF-8。GitHub 模式使用 Git 对象处理二进制；现有本地写回若出现不可表示的内容，应显示明确失败，不静默丢弃。统一冲突 UI 不能掩盖底层能力差异。
- 外部修改归属：私有执行副本与受控候选可排除普通源目录外部改动；若其他进程直接写入同一个私有执行副本，仅靠最终文件 Diff 无法严格区分来源，需要通过目录隔离和执行边界降低风险，并在验收记录该限制。
- 不可信仓库内容：克隆 URL、子模块/LFS、验证命令及 Agent 执行均有网络和命令风险。首版限定 `github.com`，受控 Git 调用、路径边界、资源配额、命令权限和日志脱敏；子模块和 LFS 单独预检，不隐式访问新主机。
- 现有未完成状态：新增字段保持旧 Session 读取兼容。新入口使用功能开关分阶段开启，先 server/shared 和迁移，再 Local Runtime，最后 Web/Desktop；回退时停止新建 GitHub 会话，保留已有交付状态以便向前修复。

## 9. 验证策略

先运行合同和纯状态机测试，再做设备侧 Git 临时仓库集成测试、file/PostgreSQL 重启恢复、Web/Desktop 交互测试，最后以受控测试仓库进行 GitHub API 端到端验收。真实推送、PR、合并是外部副作用，实施验收时使用专门测试仓库与明确授权，不对用户业务仓库执行冒烟。详细用例和证据见 Checklist。
