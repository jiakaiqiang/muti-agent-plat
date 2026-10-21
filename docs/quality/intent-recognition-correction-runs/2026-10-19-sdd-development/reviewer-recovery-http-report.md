# 审阅失败的真实 HTTP 恢复与状态聚合

Run ID：SDD-2026-10-20-reviewer-recovery-http。

实际 Nest/Sessions API、Generic LLM 适配器、隔离 File 持久化和服务重启验证：同一版本指派两位审阅者，其中一人连续返回不合格格式，另一人成功。失败者只调用两次，未生成部分意见的定稿。恢复查询返回失败 Agent 身份及可重试状态；同一请求并发提交只有一张收据，旧两次预算记录保留。显式重试后失败者仅新增一次调用，成功者步骤完整保持不变。全部意见到齐后生成新稿，可由用户确认。服务重启后原修订及重试收据均可回放，未新增模型调用。

实际检查共 12 项，详见 reviewer-recovery-http-results.json 与 reviewer-recovery-http-final.log。初次执行结果保留为 reviewer-recovery-http-before-aggregate.json 和 reviewer-recovery-http.log。供应商是本地确定性响应夹具，因此这些证据证明控制流和持久化恢复，不证明自然语言识别准确率。

同时修复状态聚合：同版本存在失败、失效或待对账的 Brief 步骤时，启动另一个步骤或重试其中一个步骤不能把整体路由显示为正常进行中。该判断只使用当前路由与版本，不受历史版本失败污染。新加“先失败、后成功”的服务回归验证整体失败状态保留，全部相关测试 41/41（reviewer-recovery-aggregate-tests.log）。最终 Server 构建（含 TypeScript）及 diff 检查通过。

本轮没有改动生产连接，没有提交或部署。未新增 PostgreSQL、实际浏览器/Electron、SSE 或进程运行中强杀矩阵；正常关闭后重启不能替代崩溃恢复证明。完整 SDD、专业工作流与独立人工标注/真实模型/发布验收门仍未完成。
