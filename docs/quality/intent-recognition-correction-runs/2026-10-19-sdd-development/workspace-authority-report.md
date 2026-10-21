# 工作区读取授权与源码就绪接入开发记录

日期：2026-10-19。本次依据 Spec、Plan、Task、Checklist 继续实现 IR05/IR06/IR09 的部分内容。前置证据为 [只读回答](workspace-answer-report.md)，完整阶段门仍未完成。

## 已实现行为

- 新增 `GET/POST /sessions/:sessionId/intent-workspace-read-authority`。GET 返回当前绑定 hash、授权、dataEpoch 和有效状态；POST 只接受 action（grant/revoke）、dataEpoch、expectedBindingHash、expectedGrantRevision、idempotencyKey，不接受客户端注入 grant/能力。
- 事务内校验会话 owner、生命周期、epoch、绑定和授权版本。撤销、重新授权均递增 grant revision，写入审计事件与 Outbox，并提升 Session revision。重复请求返回当前状态；同键不同输入、过期版本返回 409。不存在有效绑定时无法签发读权限。
- 重新授权不恢复旧计划。执行器仍比较保存版本中的完整 grant；只有新消息生成的新计划可使用新授权。Session 缓存读取和后续持久化均同步有效授权，避免缓存写回复活撤销记录。编译器不再继承历史版本的工作区读 grant。
- 新合同消息在源码准备未完成时暂缓分类，不消耗模型次数/截止时间。源码协调器完成分支绑定后，通过事务保存工作区、source 状态、审计、只读授权及 Session revision，再调度原消息。旧合同保留原路径。
- 来源就绪的系统事件作为新 grant 的来源引用。已有撤销记录不能被源码回调恢复；被删除、epoch 不符或 source version 不符的回调不能复活会话。源码事务失败保留原缓存，便于使用原版本重试。
- server_local 可获得只读授权；local_bridge 接入源码就绪调度，但没有被扩展为可读执行器，不能借此获得未经实现的读取权限。

## 验证与复现

真实 HTTP 脚本：`node tests/evaluation/run-intent-workspace-authority-sdd.mjs`，使用隔离 File 后端、真实临时文件、真实 Nest/Generic LLM 工具循环以及确定性 localhost 模型提供方。未连接真实 GitHub 或修改生产配置。

| 场景 | 验证结果 |
| --- | --- |
| WR01–WR05 | 实际读取/搜索、无任务/Brief、越界/敏感/junction 拒绝、写工具阻断、文件 hash 不变 |
| WA01 | 模型返回工具调用前通过 HTTP 撤销；旧 step invalidated，无文件读取后的后续请求、无成功回复、无预算重试 |
| WA02 | 文件读取后、模型最终回答返回前撤销；结果不发布，旧 step invalidated |
| WA03 | 授权依次变为 revision 1→2→3→4→5；新请求使用 revision 5 正常完成，旧请求保持 invalidated |

HTTP 8/8 通过，另验证同键重放、陈旧请求 409，以及 Session GET 看到已撤销授权。该测试没有声称可撤回撤销前已经读取或发送给模型的内容。

单元/服务回归覆盖并发幂等、权限字段注入、错误 owner/epoch、落盘失败回滚、旧执行版本失效、源码等待零调用、源码事务与调度、删除防复活、缓存保护和 Sessions 接入。本轮后端全量 2045 项及开发脚本 7 项通过、21 项 PostgreSQL 跳过；最后相关回归 168 项通过。全仓类型检查、Shared/Server 构建通过。本轮没有重跑 Web/Desktop 全量测试。最终命令、计数和源文件 hash 见 `workspace-authority-manifest.json`。

最初类型检查发现可选工作目录的窄化缺失，已经修正；最初故障注入测试挂在未使用的 persist 方法，改为实际 writeFileState 后验证了落盘回滚。原失败日志保留。后端全量测试及全仓类型检查启动后补强了 action 的严格字符串校验；最终相关回归、构建与 HTTP 重跑覆盖该增量。

## 尚未验证或实现

没有真实 GitHub OAuth/clone/分支选择完整网络验证；源码就绪路径由服务与持久化测试覆盖，HTTP 仍使用隔离的 server_local 兼容入口。授权撤销界面、本机 Bridge/CLI 读取、真实 PostgreSQL、完整并发故障矩阵尚待完成。

测试/源码/产物等执行器、Brief 与业务调度、特殊入口统一、执行型纠错、完整 58 场景、独立 500+ 双人标注、迁移与发布门仍未完成。未把 IR05/IR06 或 IRC-AC03/G2 标为通过；未提交、发布或部署。
