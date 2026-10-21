# 隔离测试启动参数与授权一致性开发记录

本增量依据四份 SDD 文档和系统开发设计，补齐 IR05/IR09 中版本计划派发的底层前置约束。尚未开放新合同的自动测试派发，也不将完整 IRC-AC03 或 IR05/IR09 标为通过。

## 实现

- `IsolatedTestRunStore.reserve` 在持久化事务中核对当前有效版本、运行中的计划步骤、物理调用 ID、步骤租约/总时限和任务目标。当前支持的测试形状限定为单个 `enqueue_follow_up` 步骤、一个 `run_tests` 效果、无指定 Agent；这只是当前执行器边界，其他规格能力仍待实现。
- 实际脚本、固定镜像 ID、绝对源码目录必须与当前服务端授权一致。错误参数在记录预约和调用 Docker 之前拒绝。新记录保存完整 `authorityBinding` 和源码目录，与原有容器、daemon、快照身份一并落盘。
- create/start 前及每 10 秒续期时重验授权和步骤；授权撤销、重新签发、镜像/工作区变化、步骤失效均阻止继续执行。清理及审计写入不依赖已撤销的执行权限，避免因撤销而失去停止能力。
- 快照同时拒绝根目录和祖先路径上的 symlink/junction，补齐此前只检查后代文件的缺口。
- 未改变旧合同的命令审批；未开放任意命令、源码写入、产物发布或新模型权限。

## 验证结果

| 验证 | 结果与证据 |
| --- | --- |
| 后端全量 | 2078 项 + 开发脚本 7 项通过；21 项 PostgreSQL、5 项可选 Docker 跳过。见 `test-runner-binding-server-full.log` |
| 最终串行相关回归 | 55 项通过、零跳过，包含 5 项真实 Docker 测试。见 `test-runner-binding-final.log` |
| 新增覆盖 | 9 项测试，其中 2 项真实容器测试；覆盖参数错配、状态/租约、撤销/重签/配置变化、根路径重定向与 File 重载 |
| 类型及构建 | 全仓 typecheck、Shared/Server build 通过 |
| 工程检查 | Harness、diff check 通过；指纹见 `test-runner-binding-manifest.json` |

真实容器新增验证分别确认：只执行获准的 `test:unit` 而非会失败的默认 `test`，只读源文件未改变、scratch 文件未回写、完整绑定与结果已持久化；在 Docker 确认容器实际运行后撤销持久化 grant，续期校验触发 abort，容器和快照均清理，记录中保留中止结果和原调用次数，未重跑。另有故障注入验证在 create 与 start 之间撤销时不启动进程但仍清理容器。

测试使用已有本地固定镜像 `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`，没有更改生产配置。版本计划为明确标注的合成 fixture，用于验证启动边界；运行中撤销通过 File 事务改变授权，不是授权 API 到运行时即时取消的全链验收。当前停止触发采用最长约一个 10 秒续期周期，另需 Docker 清理时间。

早期 `test-runner-binding-tests.log`、`test-runner-binding-docker.log` 分别记录新增中间阶段的 16 通过/3 跳过和 22 通过；它们早于根路径和路由状态的最终检查。最终证据以全量日志及 `test-runner-binding-final.log` 为准，计数相互重叠，不相加为独立样本。

## 尚未完成

下一步仍是版本化测试 dispatcher：从已提交计划预约调用、把独立测试 grant 贯通 Runtime/Tool 边界、选择获准脚本、撤销时定向取消，以及结果发布事务与重启对账。当前 `supportsIntentEffectScope` 和计划提交对新合同测试继续 fail closed；UI 仍提示自动执行尚未开放。

HTTP 测试派发、授权 API 即时停止、实际业务投影/测试报告发布、PostgreSQL、多实例、硬删除恢复记录保留、CLI/Bridge 和完整双端尚未验收。本轮未重跑 Web/Electron，未进行真实模型准确率评测，也未提交、发布或部署。长期任务继续保持未完成。
