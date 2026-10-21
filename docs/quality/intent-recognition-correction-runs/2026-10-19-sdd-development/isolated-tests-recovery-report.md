# 隔离测试持久化与崩溃恢复开发记录

日期：2026-10-19。继续依据四份 SDD 文档推进 IR05/IR09。本记录覆盖测试执行器的恢复基础，不代表新合同 run_tests 已接通授权和计划派发。

## 实现

在现有 LogicalOperation 中增加 isolatedTestAttempts，保存 session/dataEpoch/operation/invocation 对应的身份 hash、容器名、固定镜像、Docker daemon ID、快照路径/hash、owner/lease、绝对 deadline、执行阶段、停止证据与结果。沿用现有关系存储 source_snapshot，不新增迁移；真实 PostgreSQL 行为尚未验证。

Runtime 的测试适配器通过内部 ToolExecutionContext 传递身份，模型工具参数不能指定身份。容器操作前先提交预约；快照路径分配前保存路径；发送 create 前保存停止未知状态。生成快照后、实际启动前及租约续期时重验会话、dataEpoch、generation、操作身份、意图版本和 hold。相同 invocation 不再执行第二次。

执行租约 30 秒、每 10 秒续期；恢复只接管过期租约，使用 60 秒恢复租约。模块启动和后台扫描负责对账，核对原 Docker daemon、容器标签及固定镜像后才清理。删除后再次 inspect 确认不存在；daemon 不匹配、身份不匹配或停止未知均保留记录和阻断状态。旧 owner 不能续期或覆盖新 owner 的记录，迟到的 Runtime settle 不能把恢复中的停止未知降为已确认。

恢复不启动测试，也不重置 attempts/deadline。确认旧容器停止后，LogicalOperation 保持 interrupted，丢失结果保存为 ISOLATED_TEST_RESULT_LOST/null exitCode；不存在的会话不会被重建。测试成功必须先完成停止确认、清理与结果提交。退出码为 0 但清理失败，或结果提交失败，均不能返回成功。独立调用隔离 primitive 而没有执行身份时仍没有持久化保证；实际 Runtime 路径提供 operation/dataEpoch，授权和新合同派发尚未开放。

## 验证方法与边界

File 事务测试覆盖预约持久化、唯一身份、活跃租约不接管、过期接管、旧 owner 拒绝、不可变快照身份、终态不可续写、停止未知、迟到 settle、防隐式重试、会话暂停/换 epoch/换 generation/删除/hold、写盘失败零 Docker 调用、创建响应丢失仍清理、daemon/label 不匹配不删除。

真实 Docker 崩溃测试启动独立 Node 工作进程，等待 Docker inspect 确认容器运行，然后实际 SIGKILL 工作进程。新的 PersistenceService 从 File 重新加载记录；测试时钟向前推进 31 秒模拟租约到期，恢复服务删除旧容器和快照。断言结果丢失、操作中断、只一次 attempt、没有第二条执行记录，重复恢复不产生新执行。此为实际进程崩溃和容器清理证据，但未等待真实的 30 秒租约，也不是完整 Nest HTTP 重启场景。

真实成功路径经 TestRunnerRuntimeAdapter → TestRunnerTool → 隔离服务运行 Node 测试，验证返回 completed 前磁盘已有 finished/exitCode=0 记录。其他真实容器用例继续验证源码、网络、凭据隔离和超时子进程清理。镜像固定为上一阶段的 node:22-alpine image ID；只在测试子进程环境配置，没有修改生产模型或服务器配置。

首次相关回归 37 通过/1 失败，失败是 Docker “no such object” 文案大小写与测试断言不匹配，已修正断言并保留 isolated-tests-recovery-first.log。其后相关回归 129 项通过。首次带真实 Docker 的全量并发回归 2065 通过/1 失败/21 PostgreSQL 跳过：恢复与正常持久化两项通过，隔离基础用例的 Docker daemon 查询超过 5 秒而安全拒绝。该失败保留在 isolated-tests-recovery-server-full.log；未放宽生产超时，后续分别运行常规全量与实际 Docker 用例。最终命令、计数、退出码及源码范围由 isolated-tests-recovery-manifest.json 记录。

最终常规后端全量 2063 项及 7 项开发脚本通过，跳过 21 项 PostgreSQL 和转移到单独验证的 3 项 Docker 用例。最终串行相关回归 130 项全部通过，包含上述 3 项实际 Docker 用例、停止账本与 Runtime 回归，零跳过。全仓 typecheck、Shared/Server build、Harness 和 diff 检查通过；未重跑前端测试或完整双端 UI。计数之间重叠，不能相加为独立场景数。

## 尚未完成

run_tests 的独立用户 grant、runner 绑定、编译后的计划派发和纠错执行器仍未接通；当前新合同仍拒绝该 scope。完整双端恢复界面、CLI 权限拆分、真实 PostgreSQL/多服务实例对账、会话硬删除后的容器记录保留、全部入口与业务投影验证仍待完成。IR05、IR09 和 IRC-AC03 不整体勾选；不把这些工程回归当成模型意图识别准确率。
