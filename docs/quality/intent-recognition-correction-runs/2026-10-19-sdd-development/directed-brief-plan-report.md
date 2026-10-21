# 指定 Agent 草稿修订：计划基础

Run-id：SDD-2026-10-20-directed-brief-plan。依据四份文档，继续指定修订的完整实现，未启用用户入口。

已增加服务端内部 review_brief 动作和 prepare_brief.requiredBriefReviewStepIds。deriveDirectedBriefSteps 从已校验的无效果同任务修订计划派生全部指定目标，每目标独立身份/幂等键，定稿依赖所有审阅步骤；保留原稿版本、完整任务目标、当前需求/epoch/generation/hash 和用户原始证据。空、重复、非法或超过八个目标拒绝，不回退为 Coordinator。输入计划保持不变，不授予新效果。

执行器尚未接通，因此 Runtime 和 Brief 存储显式阻止带审阅依赖的计划，防止只识别新字段却跳过意见直接定稿。模型输出合同不接受 review_brief；生产入口未调用新派生 helper。该保护将在真实审阅执行器、结果存储和依赖重验同时完成后替换。

验证：相关 Brief/Store/新计划共 50 项通过；最终三项计划测试再次通过。Server typecheck 和 diff 检查以对应日志为据。初次最终类型检查发现测试尝试给 readonly target.agentIds 赋值，改为替换整个 target 后重跑；失败日志保留。没有运行全仓测试、构建、HTTP、数据库或双端交互，不能借前一里程碑通过数声称本轮完整验证。

后续实现见 docs/design/intent-directed-brief-revision-design-v1.md：受理名单解析、独立审阅执行与事务结果、全部意见定稿依赖、逐目标失败恢复、共享表单及真实环境验收。完整 IR06/IR09/IR10 和 AC 均保持未完成，长目标保持 active。没有提交或部署。
