# 执行型测试纠错开发与验证报告

本轮依据意图识别与纠错四件套及系统开发设计，承接 `correction-reconciliation-report.md`，完成版本化纠错后的单步骤测试派发。原接口纠错与新合同普通聊天均接入；整个专项仍在实施，其他执行效果和完整验收门尚未完成。

## 实现行为

1. 旧执行先经过既有 hold/epoch/定向停止/隔离效果对账。纠错激活事务使用当前独立测试 grant、固定 runner 资源、可用 Runtime、工作区、业务 admission 和停止状态重新编译。暂停、停止未知、目标仍有活动业务、错误资源或额外写效果均不能派发。
2. 单个 `correct_route` / `run_tests` 步骤可与 Decision、requirementRevision、意图版本、更新后的语义计划、激活事件和 Outbox 在同一事务保存为 queued。成功提交后调度既有测试执行器，不经过旧 Coordinator/Brief/任务队列。
3. `correction.status=applied` 表示新意图版本生效。此时 route.actionStatus=pending；只有独立测试执行完成并通过结果事务核验后，执行状态才变为 applied。测试失败不会伪装成纠错未发生，也不会自动重新分类或重跑旧版本。
4. 预约、启动、续期、结果发布沿用新步骤的 intent/requirement/epoch/sessionGeneration/Decision/effectScope 绑定。旧结果仍不能修改新版本。新版本有自己的单次测试预算，同键重放不产生新版本或第二次物理调用。
5. 普通聊天回复原消息时，接收事务只接受合法目标及当前授权覆盖的受限测试效果；最终激活仍重新检查所有执行条件。原消息事件复用，初次识别与纠错复核共用两次分类预算。普通计划提交服务显式拒绝 `correct_route`，不能借扩大后的测试执行器绕过纠错接收事务。
6. 若提交后调度通知丢失，重启扫描持久化 queued 步骤补发一次；事务写盘失败时没有新版本、queued 步骤或调度，原 hold 保留。

## 功能题与证据

| 检查 | 实际场景与断言 |
| --- | --- |
| TX01 | Docker inspect 确认旧容器正在运行，再纠错“重新运行 test:unit，不修改源码”；旧容器清理后，版本 2 使用独立新快照执行成功，源码不变且没有新任务或产物 |
| TC01 | 对账完成后才释放纠错 hold，旧测试结果不发布 |
| TC02 | 原请求同键重放并重启真实 Nest 进程；旧调用、新测试调用、激活和结果事件均不重复 |
| TX02 | 重启后回复原消息“再次纠正前面的测试请求”；生成版本 3/epoch 3，原 user_message 复用，两次共享分类预算，一次新测试，无旧 follow-up |
| 单元负向 | 暂停、分类期间撤销授权、错误 runner、额外源码写效果均保留 hold、零派发 |
| 故障注入 | 激活事务落盘失败、提交后通知丢失，以及普通提交绕过纠错接口的尝试 |

真实 HTTP 共 11 项（既有 TD01–TD07、TC01–TC02，加 TX01–TX02），使用 File 持久化、固定本地 Docker 镜像和确定性分类服务。初次 10 项结果保留在 `correction-test-dispatch-http-results.json`；加入普通聊天后最终 11 项为 `correction-test-dispatch-chat-http-results.json`。这些结果证明程序链路和执行约束，不作为真实模型准确率证据。

相关五组服务测试 83/83 通过；最早四文件验证为 58 通过/4 个可选 Docker 跳过，不能将其写成 62 项均通过。后端全量、类型、构建、Harness、源码指纹和命令退出码详见 `correction-test-dispatch-manifest.json`。

最终后端全量为 2098 项及开发脚本 7 项通过，0 失败；21 个 PostgreSQL 和 5 个可选 Docker 测试跳过。全仓 typecheck、最终 Server build、Harness 和 diff check 均退出码 0。本轮没有更改前端或新增共享合同，不重复上一批 Web/Desktop 完整构建；实际 Docker 另由上述 HTTP 验证。相关测试与全量计数重叠，不相加为独立样本数。

## 仍未完成

源代码修改、产物/外部写入及其补偿，ordered_plan，指定 Agent 的完整执行，通用业务任务/Brief 派发，特殊入口/结构化澄清，完整运行中崩溃、多实例、PostgreSQL、CLI/Bridge 和双端矩阵仍待完成。独立 500+ 人工双标、三次真实模型评测、迁移与发布门没有完成证据。没有将完整 IR05–IR10 或发布门勾选通过，未提交或部署。
