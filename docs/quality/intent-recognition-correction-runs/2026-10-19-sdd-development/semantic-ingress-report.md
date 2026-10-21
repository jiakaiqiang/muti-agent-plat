# Sessions 新语义入口开发记录

日期：2026-10-19。对应 IRC-R01/R07/R12/R18 与 IR06 的部分实现。前置：[回答执行器](answer-executor-report.md)。完整 G2 尚未通过。

## 实现

新增 IntentMessagePipelineService，首轮在同一事务保存 Session shell、lifecycle、原消息、路由与 Outbox，不提前创建 WorkItem、Brief 或旧 follow-up。普通消息使用同一入口，经过持久化分类、快照检查、计划编译提交，再创建任务上下文或调度纯回答。相同幂等键必须匹配原 payload；不同内容返回 409。

新建会话需同时满足 `INTENT_UNDERSTANDING_ENABLED=true` 和既有 enforce cohort，才固定 `intentContractVersion=intent-understanding-v1`。默认配置保持原行为；已经固定合同的会话即使开关关闭也继续使用新合同，不退回旧执行链。没有修改真实部署配置。精确命令和运行时控制仍由原处理器处理，不能据此宣称所有入口已经统一。

入口即保存合同标识及 epoch/generation，旧 worker 在模型提案生成前就拒绝接手。新合同的无版本业务调用被阻止；source-ready 与旧恢复流程不再隐式创建任务或启动 Brief。会话详情刷新持久化 activeWorkItemId，避免新计划创建任务后 API 继续展示旧缓存。恢复中的已接受消息与回答由对应持久化服务继续处理。

迟到失败不得覆盖已提交计划；重复阻塞保留原通知和版本。快照重建与格式修复继续共享原分类上限，不建立第二套无界重试。目标 Agent 的回答尚无对应执行器时明确 blocked，避免把指定对象悄悄改为 Coordinator。

## 验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Server 全量 | 2033 通过、7 开发脚本通过、21 PostgreSQL 跳过、0 失败 | semantic-ingress-server-tests.log |
| 最终入口/提交回归 | 22 通过 | semantic-ingress-final-regression.log |
| 全仓类型检查 | 退出码 0 | semantic-ingress-verified-typecheck.log |
| 后端构建 | 退出码 0 | semantic-ingress-verified-build.log |
| Harness / diff check | 退出码 0 | semantic-ingress-harness.log / semantic-ingress-diff-check.log |
| 实际 Sessions API 与服务器重启 | IN01–IN07 全通过 | semantic-ingress-verified-http.log / semantic-ingress-http-results.json |

全量 Server 先于最后的阻塞通知版本计数及迟到失败保护；最终 22 项、类型检查、构建和 HTTP 均覆盖这些改动。计数存在范围重叠，不累加成独立评测题目。未重跑全仓测试或实际 Web/Electron 客户端。

IN01 验证首轮识别等待期间没有任务/Brief；IN02 验证自动回答且无工具；IN03 验证普通消息不进入旧 follow-up；IN04 实际进程重启后关闭开关、启用旧迁移也不补建任务，同键重放不新增调用；IN05 不同内容同键 409；IN06 仅合法计划提交后创建任务，详情返回正确 activeWorkItemId；IN07 认证失败只请求一次，不新增业务 operation。

测试使用隔离 File 数据、真实 Nest/Generic LLM 传输和确定性 localhost provider，不代表模型准确率。首次 HTTP 的 IN06 暴露详情缓存过旧；已修复并保留失败日志 semantic-ingress-http.log。早期测试文件缺失闭合括号导致的构建失败也保留，后续类型检查和构建通过。

## 后续边界

新合同聊天纠错桥接、结构化目标澄清、受控 Brief/业务调度、实际读文件/测试/源码/产物执行器及全部特殊入口仍需实施。新合同任务创建当前只产生任务上下文，不启动业务；此 cohort 不应作为完整生产任务执行能力放量。PostgreSQL、真实 CLI/双端、58 场景与独立 500+ 双人标注、迁移/灰度/发布门保持未通过。ordered_plan 未启用。未提交、部署或修改用户模型连接。
