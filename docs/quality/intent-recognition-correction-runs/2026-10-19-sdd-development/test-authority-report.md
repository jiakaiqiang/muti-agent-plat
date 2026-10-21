# 隔离测试授权与 runner 绑定开发记录

日期：2026-10-19。继续依据四份 SDD 文档推进 IR05/IR06/IR09。当前完成授权与资源绑定，不将完整测试计划派发或 IRC-AC03 标记通过。

## 改动与行为

新增 `GET/POST /sessions/:sessionId/intent-test-authority`。GET 返回当前授权和三个固定脚本的配置候选；POST 只接受 action、script、dataEpoch、expectedBindingHash、expectedGrantRevision、idempotencyKey。脚本为 test/test:unit/test:integration；不能提交镜像、shell、grant、safeToApply 或任意执行参数。

授权绑定经过服务器校验的 server_local 工作区、owner、dataEpoch、工作区选择/绑定时间、固定镜像 ID、runner 策略版本和指定脚本。绑定 hash 生成 test_runner 资源 ID，grant 引用本次真实用户授权事件。工作区须具备 read/test 能力；不要求 command/write 能力，不由读取 grant 或旧 requiresCodeChanges 补发测试权限。镜像来自服务端 INTENT_ISOLATED_TEST_IMAGE，配置候选不代表已检查镜像存在、脚本存在或 Docker 可运行；实际执行器仍负责这些检查。

在同一持久化事务内更新 grant revision、Session revision、授权事件和 Outbox。相反选择使用 CAS；同键不同内容冲突；同键相同内容重放返回当前状态，不能恢复旧 grant。撤销可在镜像配置消失或工作区更换后针对原绑定进行。修改镜像、脚本、来源或工作区绑定使旧授权失效；新授权不唤醒旧计划。SessionsService 在缓存保存前读取持久化授权，避免后续普通消息把已撤销 grant 写回。

新合同 IntentContextSnapshot 包含有界的效果资源、有效 grants 和 runner 候选，并进入业务指纹；模型只看到服务器解析的资源 ID。配置变化会使快照失效。计划提交与纠错编译从当前 Session 获取读取/测试权限，不重新继承历史版本中的这两类 grant。执行版本门增加对 run_tests 当前 grant、resource 和 revision 的复核；这项防御测试使用构造的 validated revision，不声称完整测试派发已可用。

## 验证

相关回归 241 项通过，覆盖原有计划提交、纠错、上下文、Session 和语义 Runtime builder；新增测试验证权限独立、固定镜像/脚本/工作区绑定、并发幂等/CAS、伪造字段/跨 owner/epoch 拒绝、撤销后旧请求重放、配置消失时撤销、File 写入失败原子回滚、重启持久化、快照与最终版本门、缓存防倒退。

真实 localhost Nest HTTP TA01–TA08 全部通过，使用临时工作区、File backend 和确定性的本机 provider，并实际重启服务进程。验证默认无测试授权、重复授权仅一条效果、400/409、相反选择冲突、撤销不影响只读授权、重启幂等和旧计划不复活。TA04 还证明模型收到精确 runner 候选：请求已满足授权条件，故不报 EFFECT_NOT_AUTHORIZED，但仍报 EFFECT_CAPABILITY_UNAVAILABLE，且没有 task_execution 操作。测试配置使用格式合法的 fixture image ID，未启动 Docker；真实 Docker 证据在上一恢复阶段记录，本轮不冒充执行隔离复验或模型准确率。

首次相关测试有三项断言把生命周期初始化产生的 Outbox 当作空基线，已改为与初始化基线比较，失败日志 test-authority-first.log 保留。首次 HTTP fixture 未正确处理连接探测请求，导致本机 provider 返回 500，尚未进入模型分类；补齐非聊天路径的 404 后通过，失败日志/JSON 另存 test-authority-http-first.*。最终全量、类型、构建和 Harness 结果以 test-authority-manifest.json 为准。

最终后端全量 2071 项及开发脚本 7 项通过，21 项 PostgreSQL 与 3 项可选 Docker 用例跳过；本轮没有重跑真实 Docker。全仓类型检查、Shared/Server 构建、Harness 和 diff 检查通过。241 项相关测试与全量计数重叠，8 项 HTTP 为独立 API 场景。

## 剩余工作

授权界面、版本计划派发、实际 runner 资源传递、撤销时运行中测试停止、结果/报告发布事务仍待接通。新合同 Runtime 的 run_tests scope 仍关闭，grant 不等于执行能力。完整 CLI/Bridge/双客户端、PostgreSQL/多服务实例、源码及产物执行器、独立人工评测和发布门继续保持未完成。
