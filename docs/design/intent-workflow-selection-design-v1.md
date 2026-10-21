# 版本化工作流衔接设计

状态：实施中。已实现选择输入合同及事务前置绑定函数，尚未接入选择 API、持久化收据或节点执行。现有新合同工作流启动拦截继续保留，不表示该业务已完成。

## 目标与依据

落实意图纠错 Spec 的统一派发、权限不能扩大、旧结果不能驱动下一步要求，以及 Task 的 IR05、IR06、IR09。草稿确认增加 requirementRevision，并写入用户确认的 Decision；生成草稿时的旧 executionBinding 已不再代表确认后的上下文。不能直接复用旧 Brief 步骤或仅解除 SessionsService.selectWorkflow 的拦截。

## 选择合同与事务

`intent-workflow-select-v1` 固定数据 epoch、Brief ID/版本、意图版本、确认后的 requirementRevision、executionEpoch、sessionGeneration、工作流 ID/发布版本/definitionHash、选择卡及幂等键。严格拒绝额外授权字段。工作流版本来自持久化 workflowCatalog，不能接受客户端上传节点定义。

已实现的 bindIntentWorkflowSelection 核对当前有效且真实确认的 Brief、确认收据与原确认事件、版本化已完成生成步骤、当前 WorkItem/路由、无纠错屏障、活动会话和已确认停止状态。选择卡必须绑定相同上下文版本；发布定义 hash 必须匹配。返回确认后的 Decision hash 和不可变工作流副本，但明确 executionAuthorized=false，不创建任务、不调用模型、不授予效果。

后续受理事务必须先查已存幂等收据，再校验当前条件；相同请求重放返回原结果，不允许同键变更工作流。计划、选择收据、确认解决、会话投影和 Outbox 要在同一事务提交。失败保留可解释诊断，不能写入“已启动”事件。

## 节点计划与权限

工作流选择表达编排意愿，不授予源码、测试、产物或外部副作用权限。现有 WorkflowNode 仅含自然语言阶段描述，不能据此推断“无需权限”或“允许全部工具”。节点必须增加结构化效果需求，经过既有 EffectScopeResolver 与有效 grant、用户禁止项、节点/Runtime 能力求交；未知效果属于缺失信息，不能当作空效果。

每个节点、机器人审批及返工/替换目标必须保存对应物理步骤，绑定确认后的版本和 Decision hash。继承范围不得大于父计划；通用 ordered_plan 开关不因此开启。人工批准节点、成员补齐或机器人通过不等价于扩大执行授权。

## 执行及恢复接入顺序

1. 草稿确认事务发布版本绑定的工作流选择卡；客户端固定原始选择，冲突刷新而非自动重新绑定。
2. 新的选择事务构建节点计划和收据；作用域编译失败时保存 blocked 诊断，不启动旧工作流。
3. WorkflowRuntime 的启动、恢复、节点推进、返工、换人及后审阅统一消费物理步骤身份；调用前、结果事务及下一步发布均检查当前 binding。
4. 工作流与任务的存储从内存快照覆盖改为有版本条件的事务更新；停机恢复读取原收据和预算，未知效果先对账。
5. File/PostgreSQL 并发与失败注入、实际 API/Runtime、双端确认和崩溃测试全部通过后再移除旧拦截。

## 验收证据边界

当前测试使用真实确认服务产生的 File 状态，并在测试状态中添加选择卡/工作流定义，验证所有版本错配、暂停、未知停止、纠错屏障、缺收据与客户端伪造字段被拒绝。它不证明选择 API 已开放、工作流已执行或用户已授予权限；这些仍是后续必做工作。

## 节点编译实施增量

已增加可发布的 intentEffects 声明、全节点原子编译和父范围交集校验，代码见 intent-workflow-scope.ts。声明纳入发布 hash，缺失按未知阻止新路径。尚未接入选择受理与 WorkflowRuntime，编辑 UI 也未补齐。证据见 workflow-node-scope-report.md。
