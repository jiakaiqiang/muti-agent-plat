# 首轮测试请求与显式授权重校验实施报告

日期：2026-10-20（Asia/Shanghai）。Run ID：`SDD-2026-10-20-authorization-retry`。依据 Spec/Plan/Task/Checklist 的首轮、授权、幂等、恢复要求，继续实现 IR04–IR06/IR09；整个专项仍处于开发中。

## 本轮完成

- 首轮 `create_initial_work_item` 支持单次隔离测试及绑定同一 runner 的可选报告。缺授权先保存诊断，不创建 WorkItem、Brief、执行步骤或报告。只有校验通过，首次 WorkItem 和 queued step 才与不可变版本、回执、事件、Outbox 同事务提交。
- 新增 `POST /sessions/:sessionId/message-routings/:routingId/retry-authorization`。请求仅含合同版本、epoch、期望 routing revision 和幂等键；成功为 200。复用已保存语义和原用户消息，刷新服务器事实后重新编译，零额外模型调用，不重置分类预算。授权变化本身不触发执行。
- 仅允许原计划因权限/能力而未执行的情况；歧义、shadow、已执行、纠错屏障不适用。原文、目标、效果不被自动重写；工作区变更、任务关系改变、暂停、generation/epoch/CAS 失配及撤权竞态均重新拒绝。
- 独立 PostgreSQL 连接先刷新会话范围，再构建快照；提交时重验当前事实。成功请求记录 `authorizationRetryReceipts`，重放读取原版本；旧诊断版本保留 unknown，新计划须 validated。提交失败不会留下半个任务、步骤或回执。
- Web/Desktop 共享原请求重校验面板，当前标签页 sessionStorage 固定未知结果的原请求。刷新、并发点击或丢失响应不会换幂等键；409 刷新状态且不自动提交。POST 必须带匹配回执才显示成功；Desktop 只读时间线不提供写入口。

## 实际验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 工作区全量 | 3081 通过，0 失败；35 环境项跳过 | authorization-retry-workspace-tests.log |
| 分项计数 | CLI 102、Shared 282、Server 2135、Server 开发脚本 7、Web 504、开发监督脚本 37、Desktop 14 | 同上 |
| 最终 UI 增量 | 13/13，包括 8 项新面板及双端时间线测试、5 项授权面板测试 | authorization-retry-ui-final.log |
| 真实 PostgreSQL | 30/30；两条新增用例验证跨连接并发/旧缓存刷新与 SQL 回滚 | authorization-retry-postgres-final.log/json |
| 实际 HTTP + Docker | AR01–AR08，8/8；真实 Nest 服务、File 后端、容器测试、进程重启 | authorization-retry-http.log/results.json |
| 类型与构建 | 工作区 typecheck/build 及最终 Server、Web、Desktop 增量构建均 exit 0 | 对应 typecheck/build 日志与 manifest |
| 工程约束 | Harness 和 diff whitespace 检查 exit 0 | authorization-retry-harness.log、authorization-retry-diff-check.log |

全量测试中的 30 条 PostgreSQL 条件项在独立数据库运行全部通过；另 5 条可选 Docker 用例仍是全量中的跳过项。本轮 HTTP 的真实 Docker 验证不替代这些跳过用例。各验证范围重叠，不相加宣称更多覆盖率。

工作区全量运行之后补充了客户端 POST 回执一致性检查及 1 条测试；最终 UI 13/13、Web 类型与构建覆盖该增量。最终后端变更由全量 Server、最终 PostgreSQL 及最终 HTTP 覆盖。

## HTTP 评测题目与结论

固定输入：**“运行 test:unit 并保存测试报告，不修改源码”**。固定语义服务只提供可复现的严格合同；实际测试通过 Docker 执行，不把这组用例当作模型准确率测试。

| 编号 | 操作/问题 | 通过条件 |
| --- | --- | --- |
| AR01 | 首轮无授权请求是否提前创建任务或测试？ | 缺权限诊断；无任务、Brief、测试调用 |
| AR02 | 伪造 plan、过期 revision、无权限直接重试？ | 分别 400/409/409；不执行 |
| AR03 | 仅授予测试权，能否保存报告？ | 409，报告必须有独立授权 |
| AR04 | 增加报告权限是否自动运行旧请求？ | 不执行；模型仍只调用 1 次 |
| AR05 | 两个并发请求能否重复激活？ | 一次提交、一次幂等重放 |
| AR06 | 原请求重校验后是否正确执行？ | 一个 WorkItem、一次测试、一份报告、无 Brief；源码不变 |
| AR07 | 新版本会覆盖原诊断或重新理解用户话语吗？ | 原版本保留 unknown；新版本 validated；语义完全一致；一条回执 |
| AR08 | 真实服务重启后重放是否重复运行？ | 同键返回回执；模型、任务、测试、报告均不重复；新键拒绝 |

容器运行 journal 中保留实际镜像 ID、工作区快照 hash、退出码 0 和停止/清理确认。测试镜像为本地已存在镜像；临时服务、工作目录和 PostgreSQL 容器已清理，数据库迁移数量 23、残留故障注入 trigger 数量 0。

## 失败和修正记录

- `authorization-retry-focused.log`/`authorization-retry-related.log` 保留早期失败：工作区测试先错误地变更内容 revision 而非绑定身份，随后另一场景调用了新合同明确禁用的旧建任务 helper；改为真实绑定变化及独立任务状态夹具。类型检查修复了 readonly 数组赋值与可选提案类型收窄。
- 前两轮 HTTP 失败来自测试 provider 解析嵌入 JSON 的转义上下文，系统按 transient 预算阻塞，未发生执行。`authorization-retry-http-initial.log`、`authorization-retry-http-provider-failure.log` 保留失败证据。修正 provider 解码后通过；中间 8/8 结果单独留存，最终日志来自包含当前后端代码的重新构建。
- 最终证据指纹见 `authorization-retry-manifest.json`；历史报告和基线未覆盖或删除。

## 尚未完成的验收

本轮覆盖 IA03 中“首轮受限测试并保存报告、源码不变”的确定性路径。未新增完整浏览器/Electron/SSE 演练，客户端证据限于组件及 Store 行为。真实模型首轮语义准确率、全部 58 场景、500+ 双人独立标注与仲裁、CLI/Bridge 和全环境矩阵仍需后续完成。

通用 Brief/任务/源码/外部效果执行、复杂多目标澄清、ordered_plan、子任务授权传播、通用外部补偿仍未整体交付；相关 Task/Checklist 保持未勾选。没有提交、发布、部署、生产数据变更或生产模型配置变更。
