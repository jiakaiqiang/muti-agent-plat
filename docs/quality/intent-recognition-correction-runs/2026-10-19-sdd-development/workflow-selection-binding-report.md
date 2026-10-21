# 工作流选择的版本绑定基础

Run ID：SDD-2026-10-20-workflow-selection-binding。

审查发现草稿确认后 requirementRevision 已增加，旧 Brief 生成 binding 不再能代表确认后的约束；现有工作流选择/Runtime 不能直接解锁。新增严格 intent-workflow-select-v1 输入合同及 bindIntentWorkflowSelection 事务前置函数，绑定确认收据、Brief、意图/约束/执行/会话版本、选择卡和持久化发布定义。只返回选择上下文及当前 Decision hash，不授予效果、不创建任务或模型调用。独立设计文档记录节点效果编译、收据事务及 Runtime 全部入口的后续接入。

42 项 Brief 相关回归通过；新绑定测试从真实确认服务产生的 File 状态出发，选择卡和目录由夹具添加，验证版本错配、暂停、停止未知、纠错屏障、缺收据、定义变更和额外授权字段拒绝。最终只读读取 helper 调整后专项 1 项通过、41 项因名称过滤跳过。工作区 typecheck 通过，最终 Server typecheck 另见日志。diff 检查通过。

当前 helper 尚未进入生产选择 API，未新建或启动工作流。没有新的 HTTP、PostgreSQL、浏览器或模型准确率证据；没有运行完整工作区测试或构建。现有新合同工作流启动拦截保留，必须完成节点结构化效果、选择事务和执行守卫后才可替换。完整 SDD 仍未完成。
