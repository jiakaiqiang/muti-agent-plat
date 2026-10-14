# GitHub 会话代码交付 Checklist v1

状态：2026-09-28 实施中；当前没有完整 AC 通过证据，新建入口仍默认关闭。

关联：[Spec](../product/github-session-delivery-spec-v1.md) | [Plan](../design/github-session-delivery-plan-v1.md) | [Tasks](../implementation/github-session-delivery-tasks-v1.md)。

## 1. 验收矩阵

| AC | 对应任务 | 必须取得的证据 | 当前结果 |
| --- | --- | --- | --- |
| GSD-AC1 | T01、T03、T10 | 本机目录、本机 GitHub、服务器 GitHub 创建组合；服务器目录新建被拒；本地目录不推送 | 待执行 |
| GSD-AC2 | T05-T07、T10 | GitHub App 授权和 PAT 输入、复用/撤销、本机与服务器存储位置及泄漏扫描 | 待执行 |
| GSD-AC3 | T06-T07 | 无仓库写权限、App 未安装、令牌过期时阻止自动交付并提示 | 待执行 |
| GSD-AC4 | T04、T08-T10 | 克隆/分支选择前 Invocation 数为零；实际默认分支和手选分支正确 | 待执行 |
| GSD-AC5 | T08、T11-T12 | 缓存复用、会话工作区隔离、多项目歧义确认 | 待执行 |
| GSD-AC6 | T14 | 有命令通过、失败、不可运行、无命令用户补充四条路径；失败无推送 | 待执行 |
| GSD-AC7 | T12-T16 | 受控改动提交、Author/辅助标记、二进制改动、空改动无 PR、外部改动排除 | 待执行 |
| GSD-AC8 | T17 | 未合并更新原 PR；已合并新建；关闭重开；删分支恢复 | 待执行 |
| GSD-AC9 | T17、T22 | Agent 执行期间基础分支前进不影响任务；任务分支远端前进在推送前整合 | 待执行 |
| GSD-AC10 | T20-T21 | 所有冲突文件列出；文本三栏、颜色、快捷键、删除/改名、二进制及 Agent 建议 | 待执行 |
| GSD-AC11 | T14、T22 | 冲突解决后验证失败不推送；通过后更新原 PR，CI 后重新出现按钮 | 待执行 |
| GSD-AC12 | T19、T23 | 无 CI、pending、failed、passed 与仓库保护规则；不绕过 GitHub 拒绝 | 待执行 |
| GSD-AC13 | T23-T24 | head SHA 不匹配拒绝；用户点击才 Squash Merge；最终提交 Diff 准确 | 待执行 |
| GSD-AC14 | T02、T15、T25 | 本机离线/重连、服务重启、重复请求、超时对账和迟到回执 | 待执行 |
| GSD-AC15 | T26 | 删除仅清会话工作区，保留缓存、授权、远端 PR/分支；失败可重试 | 待执行 |
| GSD-AC16 | T10、T18、T21、T24、T27 | Web/Desktop 的准备、PR、验证、冲突、合并状态和站内通知 | 待执行 |

## 2. 合同与安全检查

- [ ] `codeSource` 与 `workingDirectory` 分离，GitHub 未加入 Workspace Provider/Runtime 枚举。
- [ ] 旧 Session 与旧服务器目录会话仍可读取；新建入口遵守来源矩阵。
- [ ] SourceBinding、DeliveryRecord、ConflictRecord 有版本、合法状态迁移和重启恢复规则。
- [ ] file/PostgreSQL 存储及迁移语义一致；令牌正文只在对应执行设备的秘密存储中。
- [ ] OAuth 回调绑定会话/设备并校验一次性 state；PAT 通过专用控件传输。
- [ ] 仓库 URL、Git 远端、命令参数、事件、错误、日志、Artifact、Agent 上下文均不含令牌。
- [ ] GitHub 地址限定 `github.com`；子模块/LFS/额外主机访问有明确边界。
- [ ] 站内通知只含引用与可展示摘要，无本机绝对路径或凭据。
- [ ] 单用户访问边界有部署验证；未建立可信用户身份时不宣称多人按发起人授权。

## 3. 状态与故障注入

- [ ] 创建后在 awaiting_auth、cloning、awaiting_base_branch、binding 任一点重启，不提前启动 Agent。
- [ ] 同仓库多会话和同缓存并发 fetch 不串改工作区或授权身份。
- [ ] Git 克隆/拉取失败保留可重试状态，无半绑定 Session。
- [ ] 缺少验证方式、验证失败、验证超时、修复后重试均有持久状态。
- [ ] 推送成功但 PR 创建回执丢失时，对账远端后不创建重复 PR。
- [ ] PR 被 GitHub 外部关闭、合并或修改 head 后刷新正确。
- [ ] 远端任务分支更新无冲突自动整合，有冲突进入统一编辑器且不强推。
- [ ] 目标分支执行期间更新不触发同步；点击合并时重新读取状态。
- [ ] `mergeable=null` 显示等待；head 变化、CI pending/failed、分支保护均禁止错误合并。
- [ ] 合并请求超时后先检查 GitHub 实际状态，不重复执行副作用。
- [ ] 本机断线时合并不可执行；重连只刷新按钮，不自动合并。
- [ ] 删除会话时正在运行的 Git 任务先可信停止，清理失败可重试，不删共享缓存。

## 4. 冲突编辑器与客户端

- [ ] 冲突总览列出所有文件、类型、处理状态和当前分支方向。
- [ ] 文本三栏显示正确，颜色可区分冲突/非冲突且不只依赖颜色表达状态。
- [ ] 快捷键可采用左右内容、撤销；焦点、键盘导航与屏幕阅读器标签正确。
- [ ] 第三栏允许手动修改，草稿刷新后可恢复；过期版本不覆盖新结果。
- [ ] Agent 建议可查看和采用，但每个文件仍由用户确认。
- [ ] 二进制、删除、改名和文件模式冲突使用类型化选择，不显示乱码。
- [ ] 冲突未全部解决或结果含未解决标记时不能提交。
- [ ] 解决后验证失败保持草稿与当前会话；通过后更新原 PR 并重新等待 CI。
- [ ] Web 与 Desktop 在常见桌面和移动宽度无重叠，长文件名、长代码行可滚动。
- [ ] 只读 PR Diff 与实际合并提交 Diff 清楚区分，最终文件列表可追溯到提交 SHA。

## 5. 预计自动验证

以下记录 2026-09-28 当前工作树的阶段性验证；通过项不代表对应 AC 全部完成。

| 命令或用例组 | 结果/证据 |
| --- | --- |
| `npm run test -w @agent-cluster/shared` | 250/250 通过；测试入口已递归收集 `src/node/` Git 用例，PR 文件请求期间 head 变化会拒绝旧差异 |
| `npm run test -w @agent-cluster/local-runtime-cli` | 94/94 通过 |
| `npm run test -w @agent-cluster/server` | 1802 项中 1782 通过、20 跳过、0 失败；后续开发脚本测试 7/7 通过。Brief 修订夹具已补项目识别方法，v2 cutover seed 已覆盖新增 GitHub 集合；服务器 GitHub 任务隔离门禁和会话删除重试新增回归用例 |
| `npm run test -w @project/web` | 366/366 通过。Web/Desktop 已删除菜单恢复按钮、归档恢复菜单测试与归档项 `status` 夹具同步；删除中刷新测试补归档列表响应。PR 分页差异需完整加载且提交版本一致才能确认审查 |
| Git 临时仓库：缓存、分支、提交、二进制、冲突和清理 | 定向通过：受控二进制候选、重复发布、远端推进、删分支恢复、文本/改名/大二进制冲突；缓存与清理全矩阵待验收 |
| file/PostgreSQL：重启、并发、幂等和迁移 | 独立临时 PostgreSQL 容器 smoke 通过（退出码 0）：普通会话和 9 条事件跨重启恢复；GitHub 待授权会话跨第二次重启保留 `WAIT_SOURCE_PREPARATION / awaiting_auth`，未生成 Brief。GitHub 交付、冲突及并发矩阵仍待验收 |
| Web/Desktop：创建、PR、三栏冲突与键盘交互 | `GitHubSourcePreparation` 2/2、`GitHubConflictEditor` 3/3、`GitHubDeliveryPanel` 5/5；新增本机设备重连后只刷新交付状态的组件测试。写回冲突共用三栏组件，完整双端交互与键盘矩阵待验收 |
| GitHub 专用测试仓库：授权、PR、CI、Squash Merge | 已获授权并完成真实验收：`https://github.com/jiakaiqiang/ai-dustbin/pull/1`；`main` 基线 `fdbdb744a1429df64324c3c0e6c0197b967270f7`，任务分支提交/head `9892355264af5c5197b94dd69d370f675e8690d0`，PR 为 `OPEN/CLEAN/MERGEABLE` 时完成 Diff 回读；仓库无配置检查，项目 `GitHubPullRequests` 实测返回 `ci=not_configured`、PR Diff 1 文件且 `hasMore=false`；使用预期 head SHA 执行 Squash Merge，实际合入提交 `8f4dc7e3a0610eb751e7965ca9627c3c49657019`，项目代码回读合入 Diff 1 文件且 `hasMore=false`；合入文件为 `AGENT_CLUSTER_GITHUB_E2E.md`；远端 PR 与任务分支按删除会话规则保留 |
| `npm run test:e2e:runtime-workspace-separation` | 本次完整组合退出码 0：本机/服务器选择、浏览器 Local Runtime、Server Runtime Worker、恢复、取消、安全、服务器源目录写回与三方合并冲突守卫依次通过。修复了旧 Runtime 输出和工作流 fixture；先前一次间歇性缺少写回记录促成只读 Codex/Claude 任务隔离及禁用自动写回的回归用例，仍需后续重复运行监测 |
| `npm run test:e2e:recovery` | 通过：执行崩溃与讨论恢复均保持待用户动作 |
| `npm run test:e2e:client-presentation` | 通过：Web/Desktop 导航、记录、工作流与只读路由；截图在 `output/playwright/client-separation` |
| `npm run typecheck`、`npm run test:harness`、`npm run build` | 当前工作树均退出码 0；Harness Phase 2 已补 `WAIT_SOURCE_PREPARATION` 对齐 |
| `git diff --check` | 退出码 0；仅有 Windows CRLF 提示 |

## 6. 证据记录模板

阶段性记录（2026-09-28，均不构成对应 AC 完成）：

- Web/Desktop 创建表单已根据服务端能力区分本机目录、本机 GitHub 和服务器 GitHub；服务端启用开关后拒绝新建服务器目录会话。共享准备面板支持 PAT、OAuth 链接、状态刷新、失败重试和带版本的真实分支选择。
- `GitHubSourcePreparation.spec.ts` 2/2 通过；`session-create-source-contract.spec.ts`、`sessions.service.spec.ts`、`source-preparation-coordinator.spec.ts` 合计 146/146 通过（断线恢复测试后另单跑 3/3）；全仓 `npm run typecheck` 通过。
- OAuth 成功回调返回不含凭据和授权引用的结果页；本机离线查授权时来源转为可重试的 `blocked`。2026-09-28 已在专用仓库完成真实分支、推送、PR、Diff、无 CI 状态判断和 Squash Merge；真实授权入口仍需在产品 UI 中完成，T11-T28 的剩余故障矩阵与双端端到端验收仍待完成。
- 交付协调器、设备侧协议和共享 Git 操作已有阶段性实现。临时 bare 仓库测试覆盖提交、任务分支远端推进/删除、改名、文本及大二进制冲突；冲突草稿并发版本检查和目标分支 SHA 失效逻辑已验证。工作区写回冲突已接入统一三栏组件：服务端写回定向测试 16/16 覆盖草稿重启恢复、版本竞争、外部修改拒绝、旧记录重试迁移及删除/改名类型选择；新增测试模拟逐文件确认后在 `applying` 阶段重启，验证 `failed` 状态仍可读取原草稿并按原内容继续应用，Session 响应只暴露布尔标记。file backend 的写回数组物理清理测试和可恢复删除的草稿清理失败门禁通过。本机桥接的精确 ChangeSet 授权已有服务端与 CLI 定向测试，协议升为 11；完整设备交互、PostgreSQL 和双端矩阵仍待验收。真实 GitHub PR/CI/合并验收仍待完成。
- 协调器定向测试 7/7：验证失败阻止推送、显式 head 合并与幂等、平台外合并刷新后仅通知一次、过期冲突草稿返回 HTTP 409；重启时 `merging` 转为 `blocked`，远端未合并时刷新只恢复审查状态，不重复合并。Web 定向测试验证本机设备离线时不展示合并入口，重连后只调用刷新；设备在线及服务端心跳门禁仍待双端端到端验证。
- GitHub CI 定向测试 6/6：Commit Status 使用 GitHub 综合 `state` 判断同一 context 的最新结果，Checks API 未完整返回时保持 `pending`，不完整状态响应拒绝；专用仓库真实回读无配置检查，Squash Merge 使用预期 head SHA 成功，待完成/失败/保护规则四态仍需专门仓库配置后验收。
- 2026-09-28 全量回归已清除此前 Server 2 项和 Web 5 项失败，运行位置组合门禁在只读任务隔离修正后连续退出码 0。只读 Server Codex/Claude 任务也必须使用隔离副本、不得自动写回；旧清单的写回模式与新调用不一致时拒绝复用。GitHub 会话的源码改动不得通过服务器目录 Artifact 写回路径应用。定向 92/92 验证，完整 GitHub 交付与外部副作用验收仍未完成。
- 服务器 GitHub `task_execution` 在 Worktree 服务缺失或 `AGENT_CLUSTER_WORKTREE_EXECUTION=false` 时拒绝执行，避免回退到服务器源工作区；普通服务器目录会话保留原行为。Runtime 定向用例覆盖拒绝路径、来源未就绪门禁和就绪后的 GitHub 工作区准备；服务端类型检查通过。完整 PostgreSQL 交付/冲突草稿恢复矩阵仍待验证。
- PR Diff 审查确认现在要求分页全部加载；页序、类型或提交 SHA 变化会丢弃拼接结果并提示重新加载。Web 组件定向 5/5、全量 366/366 通过，尚需在真实 GitHub PR 上验证长文件列表与远端状态变化。
- GitHub PR 文件列表请求前后均核对远端 head SHA，期间发生更新即返回 `GITHUB_PULL_HEAD_CHANGED`；共享包全量 250/250 通过。专用仓库 PR #1 已完成真实文件列表和合入提交 Diff 回读；真实远端竞态与 GitHub 分页上限仍待专门场景验收。
- 服务器 GitHub 会话删除定向测试 139/139 通过：独立工作区清理失败时保留 `deleting` 以便用户重试，成功后才标记 `deleted`，不会触碰授权或共享缓存。
- 本地 Runtime 全量测试 94/94 通过；本地 GitHub 授权复用、分支选择、独立工作区、交付提交和二进制候选路径均在临时仓库覆盖。
- OAuth App 配置本轮无法提供，因此 OAuth 回调端到端保持待配置，PAT 入口和真实仓库 GitHub API 链路已验证。CI/分支保护真实场景已在本地准备临时工作流，但连续三次推送均因 GitHub `443` 连接超时未产生远端分支；本轮未修改仓库分支保护设置。

| 字段 | 需记录内容 |
| --- | --- |
| 代码与环境 | commit、工作区差异、Node/npm、file/PostgreSQL、Local Runtime/Server 版本 |
| 测试隔离 | 测试仓库、设备、缓存目录、会话 ID、独立工作区 ID、真实外部操作授权 |
| 状态证据 | source/delivery/conflict 版本、operationId、PR 编号、base/head/Squash SHA |
| 验证结果 | 命令、退出码、CI 状态、通过/失败/跳过数量、日志/截图路径 |
| 清理 | 测试工作区、分支、PR 的实际清理结果；未触碰用户业务仓库 |

## 7. 完成检查

- [ ] GSD-AC1 至 GSD-AC16 均有对应实际证据，未通过和跳过项已解决或明确阻塞。
- [ ] Spec、Plan、Tasks、合同、迁移、实现、界面和实际测试结果一致。
- [ ] 真实 GitHub 副作用仅发生在明确授权的测试仓库。
- [ ] 发布、入口开关、兼容读取和回退步骤已审查。
- [ ] 上述条件满足后才将四件套状态改为完成。
