# GitHub 会话代码交付 Tasks v1

状态：2026-09-28 实施中。T01-T24 多项已有阶段性代码和测试；T20 的工作区写回冲突已接入统一编辑器，但类型矩阵、本机桥接、PostgreSQL、完整交互和真实 GitHub 验收仍未完成。各任务须按 Checklist 完成全部验收后勾选。

入口：[Spec](../product/github-session-delivery-spec-v1.md) | [Plan](../design/github-session-delivery-plan-v1.md) | [Checklist](../quality/github-session-delivery-checklist-v1.md)。

## 1. 执行规则

- 每项任务先写能失败的定向测试，再完成实现并记录 Checklist 证据；一个任务若出现多个独立失败面，继续拆分。
- 只修改表中所列模块及其定向测试、必要的共享合同和合同文档。不得改动无关 Agent/Skill/Tool、普通本地目录写回行为或 Harness 本体。
- 先完成 shared/server 的可读取合同与迁移，再开放新建 GitHub 会话入口；Local Runtime、Web 和 Desktop 版本不兼容时保持入口关闭。
- 真实 GitHub 授权、推送、PR、合并和业务仓库操作不用于默认测试；外部副作用验收只在专用测试仓库并取得明确授权后进行。
- 任务只有在实现、定向验证、相关 AC 证据都完成后才勾选；创建本任务表不表示任何任务已完成。

## 2. 任务拆解

| ID | 依赖 | 主要范围 | 交付与完成条件 |
| --- | --- | --- | --- |
| T01 | 无 | `packages/shared/src/contracts.ts`、共享合同测试 | 新增 CodeSource、SourceBinding、DeliveryRecord、ConflictView 和版本字段；旧 Session 可读（AC1、14） |
| T02 | T01 | `apps/server/src/modules/persistence/`、relational schema/迁移 | file/PostgreSQL 持久化来源、交付、冲突及授权引用；凭据正文不进 Session（AC2、14） |
| T03 | T01 | `apps/server/src/modules/sessions/`、会话控制器测试 | 创建合同接受代码来源，拒绝非法位置/来源组合；GitHub 来源不要求服务器绝对路径（AC1） |
| T04 | T02-T03 | `apps/server/src/modules/sessions/`、恢复测试 | 新增准备状态与统一 Agent 启动门禁；重试/恢复路径在 ready 前也不调用 Agent（AC4、14） |
| T05 | T01 | 新增 `apps/server/src/modules/code-hosts/` | 定义 CodeHostAdapter 与 GitHub URL 规范化；拒绝非 `github.com`、内嵌凭据及不支持的 URL（AC2、3） |
| T06 | T02、T05 | `code-hosts/`、`common/secret-cipher.ts` 及测试 | GitHub App 授权启动/回调、PAT 专用输入、服务端加密存储、复用与断开；权限预检（AC2、3） |
| T07 | T01、T06 | `packages/shared/src/local-runtime-contracts.ts`、`local-runtime/`、`packages/local-runtime-cli/src/` | 本机令牌一次性交接、DPAPI 保存、授权引用及设备绑定；服务端不持久化本机令牌（AC2、14） |
| T08 | T05、T07 | 新增 `repository-workspaces/`、Local Runtime 对应操作 | 受控缓存拉取、授权身份隔离、锁和唯一会话工作区；Git 凭据不写入 URL/参数/日志（AC5） |
| T09 | T04、T08 | `sessions/`、`repository-workspaces/` | 克隆后获取真实默认分支/列表，持久化用户选择与 base SHA，绑定工作区并放行 Agent（AC4） |
| T10 | T09 | `apps/web/src/components/SessionWorkspace.vue`、Desktop 创建界面、store | 创建来源选择、会话授权控件、克隆状态和分支弹窗；不提前选择子项目（AC1、2、4、16） |
| T11 | T09 | `orchestrator/`、`context-v2/` 或现有工作区索引 | Agent 从仓库识别目标项目；多个候选时产生会话确认并等待答复（AC5） |
| T12 | T08 | `worktree-execution/`、`repository-workspaces/`、`packages/local-runtime-cli/src/runtime.ts` | GitHub 专用任务级 Git 执行副本和候选提交；保留 `.git`，覆盖二进制改动；本地目录仍走原 ChangeSet（AC5、7、10） |
| T13 | T12 | `repository-workspaces/`、定向测试 | 建立受控提交清单，仅整合候选结果；源目录平台外修改不进入提交且不被删除（AC7） |
| T14 | T09、T12 | 新增 `delivery/validation-*`、orchestrator 交付入口 | 结构化识别验证命令并实际执行；无命令询问用户，失败/不可运行暂停推送（AC6） |
| T15 | T02、T14 | `delivery/`、持久化/状态机测试 | DeliveryState 的合法迁移、版本比较、幂等操作记录与重启恢复（AC7、14） |
| T16 | T13-T15 | `delivery/`、设备侧 Git 操作 | Author 身份与辅助标记、自动分支、受控提交、验证后推送；无改动不创建空 PR（AC7） |
| T17 | T16 | `code-hosts/`、`delivery/` | 创建/更新 PR；同会话复用、合并后新建、关闭后重开、分支删除后恢复；失败对账（AC8） |
| T18 | T15、T17 | `events/`、Web 通知中心、Session UI | PR 创建/更新、验证失败、冲突、合并结果站内事件；无秘密和本机路径（AC16） |
| T19 | T17 | `code-hosts/`、`delivery/` | 检查 GitHub CI 与保护状态；CI 缺失/等待/失败/通过四态门禁（AC12） |
| T20 | T12、T15 | 新增 `conflicts/`、`workspaces/workspace-writeback.service.ts` | Git 三阶段对象和现有写回冲突统一投影；文本、删除/改名、二进制及草稿版本合同（AC10） |
| T21 | T20 | Web/ Desktop 冲突组件、store、样式及可访问性测试 | 文件总览、左右对比、可编辑结果、颜色、快捷键、二进制选择和 Agent 建议逐文件确认（AC10、16） |
| T22 | T14、T19-T21 | `conflicts/`、`delivery/`、设备侧 Git 操作 | 冲突解决候选重新验证、提交并更新原 PR；CI 后重新显示合并按钮（AC9-11） |
| T23 | T19、T22 | `delivery/`、`code-hosts/`、会话控制器 | 合并请求的操作人、Idempotency-Key、expectedHeadSha、在线/心跳与状态检查；Squash Merge（AC12-14） |
| T24 | T23 | `delivery/`、GitHub Diff API、Web/Desktop | 以实际 Squash commit 查询合入文件/差异；PR 预览与最终合入结果分开显示（AC13、16） |
| T25 | T07、T15、T23 | `local-runtime/`、`delivery/`、`recovery/` | 离线禁用、重连对账、服务重启、超时后远端查询、重复请求与迟到回执（AC14） |
| T26 | T08、T25 | `sessions/`、`repository-workspaces/`、Local Runtime | 删除会话清理独立工作区和草稿，保留缓存/授权/远端 PR；失败可重试（AC15） |
| T27 | T03、T18、T23 | `docs/contracts/`、shared/web 类型映射 | 同步 API、Data、Event、Runtime 和 UI-State 合同；核查所有字段无令牌暴露（AC1、2、16） |
| T28 | T10-T27 | `tests/e2e/`、各模块 spec、Checklist | 执行故障矩阵、file/PostgreSQL、Web/Desktop、受控 Git fixture；回填每项 AC 的实际证据（AC1-16） |

## 3. 阶段依赖与退出条件

| 阶段 | 任务 | 退出条件 |
| --- | --- | --- |
| A. 合同与准备 | T01-T11 | GitHub 会话从创建到 Agent 启动可恢复；旧会话不回归 |
| B. 执行与 PR | T12-T18 | 受控候选、验证、提交、推送、PR 复用完整；失败不推送 |
| C. 冲突与合并 | T19-T24 | 所有可处理冲突进统一编辑器，CI 门禁和用户二次点击生效 |
| D. 恢复与验收 | T25-T28 | 离线、重启、清理、并发、合同与客户端证据齐全 |

关键路径：T01-T04 -> T05-T10 -> T12-T17 -> T19-T23 -> T25-T28。T20-T21 可在 PR 基础链路稳定后与 CI 门禁并行实施，但不能缺席正式发布。

## 4. 预计验证命令

实施时以实际新增脚本为准，至少覆盖：

```bash
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/local-runtime-cli
npm run test -w @agent-cluster/server
npm run test -w @project/web
npm run test:e2e:runtime-workspace-separation
npm run test:e2e:recovery
npm run test:e2e:client-presentation
npm run typecheck
npm run test:harness
npm run build
```

新增 GitHub 受控仓库 E2E、冲突编辑器交互和故障注入应作为本专项门禁；真实 GitHub 外部调用单独记录授权、仓库、PR、清理和结果。仅改本四件套时不要求运行完整应用测试。
