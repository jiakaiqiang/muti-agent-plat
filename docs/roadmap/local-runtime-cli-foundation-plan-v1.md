# Local Runtime CLI 基础能力计划 v1

> 日期：2026-07-23
>
> 最近更新：2026-07-24
>
> 状态：Windows + Codex/Claude Code 单用户内部预览；Claude 本机适配器已完成 Stub 验收，真实付费回归仍待单独确认；M1 生产边界收口、M2 执行正确性和 M3 端到端验收均已完成；签名分发、自动升级、多用户体系和主动唤醒仍属后续范围，尚未达到正式产品化交付标准
>
> 设计依据：[本地与服务器 Runtime 工作区隔离讨论结果](../design/local-and-server-runtime-workspace-separation-discussion-result-v1.md)

## 0. 当前范围决策

- 当前产品按**单用户模式**实施，固定所有者标识为 `ownerId = local-user`。
- 当前不建设 `tenantId`、组织、成员、角色和租户数据隔离模型。
- 当前所有设备、工作区、会话和 invocation 均归属这个唯一用户；不提供用户切换、成员邀请或租户管理入口。
- 服务端是唯一的所有者赋值来源：客户端不得提交、切换或覆盖 `ownerId`，也不得提交 `tenantId`；相关资源查询和写入统一限定为 `ownerId = local-user`。
- 单用户不等于无鉴权：部署到服务器后，设备审批、设备列表、设备撤销和工作区管理接口必须受单用户管理员凭据保护。
- 生产环境未配置管理员凭据时，Local Runtime 管理能力必须 fail closed；开发环境仅允许显式配置的回环地址豁免。
- `ownerId` 继续保留在合同和持久化模型中，作为未来升级多用户或租户体系的兼容点；该升级不属于当前交付范围。

### 认证术语边界

- 当前不使用“租户鉴权”作为本阶段能力名称，因为系统没有租户、组织和成员模型。
- 当前只实现两层认证：平台管理接口使用**单用户管理员鉴权**，Local Runtime CLI 使用**设备认证**。
- 单用户管理员凭据用于保护设备审批、设备撤销和工作区管理等控制面操作；它不是租户令牌，也不表达不同用户之间的数据隔离。
- CLI 设备令牌只代表一台已批准设备，不能替代管理员凭据执行管理操作。
- 只有产品明确进入多用户协作阶段后，才单独立项设计账号登录、`tenantId`、成员角色、资源归属和跨租户隔离；当前代码不得提前依赖这些概念。

## 1. 已交付目标

当前版本已经形成 Local Runtime CLI 到平台的基础闭环：

1. CLI 使用设备码与平台绑定，支持短期访问令牌、刷新令牌轮换和设备撤销。
2. CLI 上报自身版本、协议版本和实际可用 Runtime，平台执行兼容性闸门。
3. 用户通过 CLI 注册和撤销本地工作区，平台只接收不透明 `workspaceId`，不接收本地绝对路径。
4. Local Runtime invocation 在用户机器的隔离暂存目录执行，生成 ChangeSet 后由工作区权限、路径和哈希检查应用到授权目录。
5. 服务器 Codex/Claude invocation 由独立子进程 Worker 执行，不与 Nest 控制面共享进程生命周期。
6. CLI、Browser Broker 或后端断线会中断 invocation 并持久化可唤醒状态，不自动续跑。

## 2. 当前交付范围

### 已实现

- npm workspace 形式的内部预览 CLI，命令名为 `agent-runtime`。
- `login`、`start`、`status`、`version`、`workspace add/list/revoke/grant/reset-permissions`、`revoke` 和 `logs` 命令。
- 设备码认证、令牌刷新/轮换、服务端哈希存储、设备撤销和协议兼容检查。
- `local_bridge` 会话合同、Workspace Provider、Runtime 路由和前端工作区选择。
- CLI 主动建立出站 WebSocket、注册工作区、心跳、文件操作、invocation、事件、结果和取消协议。
- 已具备工作区边界、符号链接逃逸、统一敏感路径、平台仓库全子目录拒绝、版本/哈希冲突和平台/CLI 权限交集检查。
- Windows + Codex/Claude Code 执行链路；Adapter Registry 只向平台宣告本机实际检测到的 Runtime。
- 已具备服务器 Runtime 独立子进程 Worker、平台源码目录拒绝和稳定后端启动入口；Worker 不可用时 fail closed，且只继承白名单环境变量。
- SSE 瞬时断线重连状态和 invocation 中断持久化。

### 本轮已完成整改

- 为 Local Runtime 设备和工作区管理接口增加单用户管理员鉴权，不引入租户模型。
- 拒绝平台注册仓库根目录及其所有子目录作为 Agent 工作区，包括大小写、规范化路径和符号链接场景。
- ChangeSet 覆盖工作区内全部文件类型；无法安全处理的二进制或大文件必须显式失败，不允许静默遗漏后仍返回完成。
- 平台下发权限与 CLI 本地权限取交集，并分别执行测试、普通命令、依赖安装、删除等能力策略。
- 统一敏感路径规则，覆盖 `.env.*`、Docker 凭据、Git/SSH 凭据、证书和密钥文件。
- 服务器 Codex/Claude 必须经独立 Worker 执行；Worker 不可用时 fail closed，禁止回退到 Nest 进程内执行。
- 完善操作级审计、修订号校验、并发锁和 Windows 子进程树终止。

### M3 已完成验证

- 浏览器到真实 CLI 的端到端链路已经到达 `COMPLETED`，覆盖工作区注册、`local_bridge` 会话创建、Task Brief、工作流选择、Fixture Runtime、ChangeSet 应用和真实本地文件落盘。
- 已验证本地 invocation 事件可追踪到 `executionLocation = local`，且平台持久化数据不包含用户机器的本地绝对路径。
- 已完成服务器独立 Worker 成功链路，验证 Runtime 在不同于 Nest 的子进程执行，执行前后 Nest 的 PID 和 `startedAt` 不变。
- 已完成后端重启恢复验收：执行中和讨论中的会话均持久化为可唤醒中断状态，且不会自动续跑。
- 已修复暂停状态机：结构化 `ExecutionTermination` 会从 Execution 经 Orchestrator 透传至 Workflow Runtime；暂停保持 `WAIT_USER_DECISION` 并可恢复，显式取消会话仍进入终态。
- 已完成 CLI、浏览器和 Worker 断线矩阵，以及安全、权限交集、并发写入、Worker 崩溃和 Windows 子进程树终止回归。
- `test:e2e:runtime-workspace-separation` 的七段聚合链路已全部通过，覆盖本地 CLI、服务器 Worker、后端恢复、暂停/恢复、安全拒绝、平台源码写入保护和冲突保护。
- 仓库级全量 `typecheck`、`test`、`test:harness` 和 `build` 已全部通过，质量验收文档已同步。
- 当前范围达到 M3 完成定义；正式产品化交付仍需完成 M4，不因 M3 完成而提前开放签名发布、自动升级或多用户能力。

### 后续范围

- 签名的独立可执行文件、安装器、发布渠道、回滚和自动升级。
- Local Runtime 对 Claude Code 的真实付费回归、生产样本和其他操作系统的正式支持。
- 由浏览器直接触发 CLI 本地目录选择器；当前先由 CLI 注册，再由浏览器选择已连接工作区。
- 持久化脱敏本地日志；预览版当前输出到 stdout/stderr。
- 用户主动重新连接事件流并“唤醒”会话的 API、状态机、幂等键和 UI；本轮只持久化可唤醒中断状态，不提供手动连接入口。

## 3. 架构不变量

- Local Runtime CLI 安装并运行在用户机器上。
- CLI 主动向平台建立出站连接，不要求用户暴露公网本地端口。
- 远端任务只能引用 CLI 已注册的 `workspaceId`，不能下发任意本地绝对路径。
- CLI 只能操作用户明确授权的目录和能力。
- 平台源码仓库根目录及其全部子目录不得注册为 Agent 业务工作区。
- 本地凭据、目录路径和 Runtime 凭据不得写入平台源码仓库。
- 单用户服务器部署仍必须执行管理员鉴权，不能暴露匿名设备审批和工作区管理接口。
- 认证失败、协议不兼容、授权不足或工作区离线时必须 fail closed。
- Local Runtime 不可用时不能静默切换到服务器 Runtime，反向也一样。
- 服务器 Runtime 使用独立子进程 Worker，不与 Nest 后端共享生命周期，也不允许回退到进程内 Runtime。
- Agent 产生的文件变更必须全部进入 ChangeSet 并被应用，或以明确错误终止，不得静默丢失。
- CLI、浏览器或平台后端断开时中断当前 invocation，不自动恢复。
- 中断状态持久化到原会话，后续只能由用户主动唤醒。

## 4. 默认权限

| 能力 | 默认策略 |
| --- | --- |
| 读取工作区文件 | 允许 |
| 创建和修改工作区文件 | 允许，但仅限授权工作区 |
| 删除或移动文件 | 识别为危险动作后暂停，由用户确认并仅放行一次 |
| 运行工作区测试 | 允许，仅限授权工作区 |
| 执行普通命令 | 允许，在隔离 staging 目录内执行 |
| 安装依赖 | 识别为危险动作后暂停，由用户确认并仅放行一次 |
| 危险命令、目录外访问、凭据访问 | 始终拒绝 |

权限由平台合同和 CLI 本地策略共同约束，任一侧拒绝时均不执行。Local Runtime 协议 v4 支持平台向 CLI 发放下一次调用有效的一次性权限；CLI 消费后立即恢复默认策略。旧版持久状态中的 `command_execute: confirm` 在加载时迁移为默认允许。

## 5. 已采用的阶段决策

| 决策 | 当前方案 | 后续方向 |
| --- | --- | --- |
| 用户模型 | 单用户，固定 `ownerId = local-user`，不引入 `tenantId` | 未来按独立项目升级多用户或租户体系 |
| CLI 发布 | npm workspace 内部预览 | 签名独立可执行文件和安装器 |
| 设备认证 | 设备码登录 + 单用户管理员审批鉴权 | 多用户阶段再接入账号、成员和租户鉴权 |
| 升级 | 手动检查，平台执行兼容闸门 | 签名、回滚成熟后自动升级 |
| 工作区入口 | CLI 注册，浏览器选择已连接工作区 | 浏览器触发本地选择器 |
| 首期平台 | Windows + Codex/Claude Code 内部预览 | Claude 真实付费回归、macOS、Linux |
| 服务器隔离 | 独立子进程 Worker，禁止进程内回退并使用环境变量白名单 | 多用户阶段再评估容器级隔离 |
| 断线恢复 | 中断并持久化，不自动续跑 | 用户主动唤醒 |

## 6. SESSION-WAKE-UP 后续计划

| 属性 | 内容 |
| --- | --- |
| 状态 | 已登记，后续实现；当前不启动 |
| 触发场景 | CLI 断线、浏览器断线、平台后端重启或其他导致 invocation 中断的情况 |
| 目标 | 用户在原会话中主动唤醒，重新校验环境后创建新的 invocation |
| 已完成前置 | 设备认证、工作区授权、版本兼容、中断原因和可唤醒状态持久化 |
| 核心约束 | 不自动续跑；不重复应用旧变更；唤醒必须可审计并具备幂等保护 |
| 待设计 | API、事件、状态机、幂等键、UI 入口、超时和失败反馈 |

## 7. 当前完成定义

- [x] CLI 可绑定、刷新和撤销设备凭据。
- [x] 平台可判断 CLI、协议和本地 Runtime 是否兼容。
- [x] 用户可注册、查看和撤销本地工作区。
- [x] `local_bridge` invocation 在本机执行，离线时不降级到服务器。
- [x] 后端重启时的中断和可唤醒状态持久化，不自动续跑。
- [x] 当前合同、单元、WebSocket 集成和进程级基础测试通过。
- [x] 设备审批、设备管理和工作区管理接口完成单用户管理员鉴权。
- [x] CLI 拒绝平台仓库根目录及其全部子目录，且覆盖规范化、大小写和符号链接测试。
- [x] 敏感路径规则覆盖环境文件、凭据、证书和密钥，所有文件入口复用同一套检查。
- [x] 平台权限与 CLI 本地权限取交集，并区分测试、普通命令、依赖安装和删除权限。
- [x] ChangeSet 不静默遗漏文件类型、二进制文件或大文件。
- [x] 服务器 Codex/Claude 只能由独立 Worker 执行，Worker 异常时 fail closed，并使用环境变量白名单。
- [x] 工作区操作合同包含 `invocationId`、工作区修订号、权限快照和所有者信息，并逐操作校验与审计。
- [x] ChangeSet 应用具备并发锁和写入前复验，Windows 断线能终止完整子进程树。
- [x] 浏览器创建会话到真实 CLI、Fixture Runtime、ChangeSet 和本地文件落盘的完整端到端验收通过。
- [x] 服务器 Runtime 由独立 Worker 完成真实成功链路，Nest 控制面在执行期间没有重启。
- [x] 后端重启恢复验收覆盖执行阶段和讨论阶段，均中断且不自动续跑。
- [x] 暂停保持可恢复状态，恢复后创建新的执行尝试；显式取消仍进入终态，二者语义不得混淆。
- [x] CLI、浏览器和 Worker 断线、安全拒绝及并发写入的聚合回归通过。
- [x] 仓库级全量 `typecheck`、`test`、`test:harness` 和 `build` 全部通过，并同步最终验收证据。
- [x] Local Claude Adapter Registry 与 Stub 验收已完成；签名独立分发、自动升级、Claude 真实付费回归、多操作系统和会话唤醒仍登记为后续范围，不计入当前 M3 完成条件。

## 8. 当前实施计划

| 阶段 | 优先级 | 状态 | 目标 | 主要交付物 |
| --- | --- | --- | --- | --- |
| M1：生产边界收口 | P0 | 已完成 | 单用户服务器部署不暴露匿名管理面，Agent 不可操作平台源码 | 单用户管理员鉴权、平台仓库全子目录拒绝、Worker fail closed、Worker 环境变量白名单 |
| M2：执行正确性 | P1 | 已完成 | 所有变更、权限和进程生命周期都有明确且一致的结果 | 完整 ChangeSet、权限交集、统一敏感路径、操作合同与审计、并发锁、Windows 进程树终止 |
| M3：端到端验收 | P1 | 已完成 | 用真实链路证明本地和服务器模式符合架构边界 | 浏览器到 CLI E2E、服务器 Worker E2E、断线和安全回归测试、验收证据更新 |
| M4：产品化 | P2 | 后续冻结 | 从内部预览升级为可维护的正式交付 | 签名安装包、升级与回滚、持久化脱敏日志、服务守护、Local Claude 真实验收、macOS/Linux |

### M1：生产边界收口（已完成）

- 增加单用户管理员凭据配置、认证守卫和启动配置校验。
- 保护设备码审批、设备列表、设备撤销、工作区列表和工作区撤销等管理接口。
- 保留设备短期令牌用于 CLI 连接，不以设备令牌替代管理员管理权限。
- 提取统一的平台仓库包含关系检查，拒绝根目录和所有后代目录。
- 移除服务器 Runtime 进程内回退开关；Worker 不可用时返回明确错误。
- Worker 只继承执行所需环境变量，不继承后端数据库、认证和平台密钥。

### M2：执行正确性（已完成）

- 以文件清单和哈希为基础生成 ChangeSet，不再依赖固定扩展名白名单。
- 对暂不支持的二进制和大文件提供明确错误或专用传输路径。
- 定义有效权限为“平台策略与 CLI 本地策略的交集”，实现一次性授权和持久授权边界。
- 将 `test_execute`、`command_execute`、`dependency_install` 和 `file_delete` 分别校验。
- 统一复制、读取、搜索、执行和应用变更时的敏感路径检查。
- 为工作区操作增加 invocation、修订号、所有者和权限快照，并写入脱敏审计记录。
- ChangeSet 应用前逐项复验哈希和路径，增加工作区/文件锁，防止并发和符号链接竞态。
- Windows 使用进程树级终止策略，验证 CLI 断线后子进程和孙进程均退出。

### M3：端到端验收（已完成）

- [x] 建立“浏览器创建 `local_bridge` 会话 -> 后端路由 -> 真实 CLI -> Fixture Runtime”自动化脚本和独立临时工作区。
- [x] 验证浏览器工作区发现、会话创建、Task Brief 生成与确认、工作流选择均经过真实 Local Runtime 连接。
- [x] 修复端到端执行暴露的管理 API 响应信封、`local_bridge` authority 传递和 Windows 持久化瞬时锁问题，并增加定向回归测试。
- [x] 修复 Local Runtime 结果与工作区修订号的竞态，通过协议 v2 原子回传执行结果和执行后 revision，防止后续 invocation 使用旧 revision。
- [x] 真实本地链路到达 `COMPLETED`，ChangeSet 写入真实本地文件；事件可证明 `executionLocation = local`，平台持久化数据不包含本地绝对路径。
- [x] 覆盖“服务器会话 -> 独立 Worker -> Fixture Codex/Claude -> 结果回传”，并验证 Nest PID 和 `startedAt` 不变化。
- [x] 覆盖后端重启时执行阶段和讨论阶段的恢复，两种场景都进入可唤醒中断状态且不自动续跑。
- [x] 修复暂停/恢复状态机：暂停不得被工作流投影为 `CANCELLED`，恢复后可以重新调度当前节点；显式取消行为保持不变。
- [x] 补齐 CLI 断线、浏览器断线、Worker 崩溃、并发写入和权限拒绝，并将后端重启恢复纳入聚合回归；所有断线均中断且不自动续跑。
- [x] 运行 `test:e2e:runtime-workspace-separation`，七段聚合链路全部通过。
- [x] 运行全量 `typecheck`、`test`、`test:harness` 和 `build`，全部通过后更新质量验收文档并完成 M3。

### M3 完成收尾

1. 仓库级 `npm run typecheck` 已通过，CLI、Shared 和 Server 均无类型错误。
2. `npm run test` 已按 workspace 串行通过，避免 Windows 并发子进程资源竞争。
3. `npm run test:harness` 与 `npm run build` 已通过，Harness 合同和生产构建均完成验证。
4. 最终命令、测试数量和非阻塞构建警告已同步到质量验收文档。
5. M3 已标记完成；单用户决策不等同于放宽认证、安全或正式产品化门禁。

### 当前验证证据

- Shared 合同与安全规则测试：75 项通过，0 失败。
- Local Runtime CLI 工作区、ChangeSet、权限、并发和进程树测试：13 项通过，0 失败。
- 单用户管理员鉴权、Local Runtime 连接、Browser Broker 和数据纪元相关后端定向测试：28 项通过，0 失败。
- Local Runtime 协议 v2、认证、连接和 Browser Broker 本轮增量定向测试：13 项通过，0 失败。
- `npm run test:e2e:browser-local-runtime-cli`：通过；会话到达 `COMPLETED`，本地文件已写入，执行位置与路径脱敏断言通过。
- `npm run test:e2e:codex-runtime-stub`：通过；服务器 Worker 完成执行，Nest PID 和 `startedAt` 保持不变。
- `npm run test:e2e:recovery`：通过；执行阶段和讨论阶段的后端重启均进入可唤醒中断状态且未自动续跑。
- `npm run test:e2e:cancel`：通过；暂停期间无执行进度，保持等待状态，恢复后完成且只产生一次最终交付。
- Local Runtime CLI 全量定向测试：13 项通过，0 失败；覆盖 ChangeSet、权限交集、二进制/大文件失败、并发、敏感路径、修订号和进程树终止。
- 前端 SSE 与 Session 断线定向测试：连接错误后客户端关闭当前 SSE 且不自动重连；最终断线进入可唤醒中断。手动重新连接与会话唤醒入口保留在后续计划中。
- 后端断线、安全、权限与并发定向矩阵：38 项通过，0 失败；Shared 定向合同矩阵：6 项通过，0 失败。
- 服务器 Worker 真实崩溃测试：4 项通过，0 失败；子进程异常不影响 Nest 父进程，且不回退到进程内 Runtime。
- `npm run test:e2e:runtime-workspace-separation`：通过；共七段，依次覆盖浏览器到本地 CLI、服务器 Codex Worker、恢复、暂停/恢复、安全、平台源码写入保护和并发冲突保护。
- `npm run typecheck`：通过；所有具备类型检查脚本的 workspace 均通过。
- `npm run test`：通过；Shared 75 项、Local Runtime CLI 13 项、Server 1010 项、Web 118 项和开发监督器 6 项通过，Server 另有 4 项按平台条件跳过。
- `npm run test:harness`：通过；Harness 阶段 1-5、v2-only 合同和浏览器黄金路径均通过。
- `npm run build`：通过；仅有依赖 `PURE` 注释位置和 Web 主 chunk 大小两类非阻塞警告。
- 上述结果确认 M1、M2 可以标记完成。
- M3 的功能、聚合 E2E 和仓库级全量质量门禁全部通过，标记为“已完成”。

## 9. 验收门禁

进入服务器生产部署前，必须同时满足：

- 单用户管理员鉴权开启，未认证请求不能审批设备或管理工作区。
- 设备、工作区、会话和 invocation 均由服务端写入并校验固定的 `ownerId = local-user`；客户端提供的所有者或租户字段不能改变资源归属。
- 平台仓库及所有子目录不能注册为本地或服务器业务工作区。
- 不存在服务器 Runtime 进程内回退路径，Worker 不能获得无关后端密钥。
- ChangeSet 对所有创建、修改、删除均可追踪；不支持的文件必须显式失败。
- 平台和 CLI 任一侧拒绝的权限都不能执行，敏感路径始终拒绝。
- 任意断线或服务重启都不会自动续跑 invocation；完整进程树会被终止。
- 本地模式不可静默切换服务器模式，服务器模式也不可切换到本地模式。
- 合同、单元、集成、安全、真实进程和完整端到端测试全部通过。

建议验证命令：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
```

## 10. 后续冻结项

以下能力已登记，但不得阻塞当前单用户整改，也不应在当前阶段提前扩张范围：

- 多用户、组织、成员、角色、`tenantId` 和租户级数据隔离。
- 会话主动唤醒 API、状态机和 UI。
- 签名分发、自动升级和回滚。
- Local Claude 真实付费回归、macOS 和 Linux 正式支持。
- 浏览器直接触发 CLI 本地目录选择器。

详细证据见 [Local/Server Runtime 工作区隔离实现验收](../quality/local-and-server-runtime-workspace-separation-acceptance-v1.md)。
