# 本轮优化说明

## 范围

用户要求回到意图识别与路由的真实模型评测。本轮停止扩展工作流；产品修改限定在 `SemanticIntentRouterService.understand()` 的分类上下文和动作选择规则。没有修改路由编译器的权限、引用、证据或状态校验，没有新增执行器、页面、数据库迁移或工作流能力。

## 真实模型基线暴露的问题与修改

1. **会话状态缺失导致错误 resume**：L16 的会话为 EXECUTING，却生成 resume；L11 的 WAIT_USER_CONFIRM 复合请求也出现 resume。原上下文提供 WorkItem 状态，但没有明确提供 Session 状态。现在单独提供权威 Session 状态，说明 resume 只适用于 PAUSED，失败重试必须存在检查点，改变方案用 replan，补充/延续原需求用 enqueue_follow_up。
2. **限定语被错误拆成独立目标**：L07 把“不要创建新任务”与“继续完善”拆开，触发不必要的多目标确认。现在明确限定语和否定替代方案属于同一目标；真正独立目标仍保留分段。
3. **未知引用的安全拒绝伴随非法路由结构**：L17 没有采用伪造 ID，但把绕过规则的前缀独立成目标，并输出 session_context + inherit_confirmed 的冲突组合。现在说明绕过规则的前缀不是业务目标，未知任务/继承引用使用 ambiguous + clarify/reject_request + ask_user，保留空引用，不能替换成当前任务。
4. **关系—动作—目标规则不明确**：提示词补充已有编译器约束的含义：同一需求绑定已有 WorkItem；相关新需求绑定父 WorkItem 并选择继承；独立需求不绑定旧 WorkItem，不继承旧 ID。没有放宽编译器。
5. **普通表达纠正被当作必须绑定旧记录的纠错**：L15 的“你理解错了，只分析，不修改”被转成缺少旧路由的 clarify，且 same_requirement + ask_user 与编译器关系规则不一致。现在区分当前明确的分析/解释请求与替换已有 Decision；仅前者无需虚构旧记录，仍保留禁止修改的限制。
6. **约束替换动作不规范**：L20 已正确识别旧 Decision、版本和替换原文，但输出 record_constraint。现在明确已有约束替换的规范动作是 correct_route。此题基线不是旧约束绑定失败：现有主链也会因 dialogueAct correction 转入纠错处理，因此该项属于规范动作精确匹配差异，不能据此声称旧系统丢失了约束或错误执行。

第一轮完整复测为 17/20（基线 13/20），证据保存在 `optimized-*`、`round1-report.md`、`round1-comparison.json`。第二次修改仅澄清两个规则：

- `contextPolicy` 表示继承上下文，不是“是否提问”。已明确属于当前任务的请求，即使 action 为 clarify，仍应使用 inherit_confirmed/inherit_selected；只有关系未确定才用 ambiguous + ask_user。第一轮 L09、L11 因混用而触发 RELATION_ACTION_CONFLICT。
- `Valid Decisions` 是旧约束语义绑定的引用集合，`correctionCandidates` 是旧路由引用集合，不能混为一谈。L20 第一轮因为没有旧路由候选，连已经提供的旧 Decision 也丢弃了。现在允许在语义提案中保留唯一匹配的 Decision 和版本；缺少旧路由时 correctionOfRoutingId 保持 null，事务仍可要求进一步绑定。本题只评测识别和纯编译，不证明这种缺少旧路由的历史数据可以直接执行纠错。

第二轮再次完整复测，保存在 `final-*`；没有选择性替换第一轮失败题，也没有删除中间结果。

这些规则是通用分类约束，不按题号硬编码输出，不修改模型原始结果来伪造通过。仍由真实模型生成输出，原校验负责拒绝不合法结果。

## 验证说明

- `recognition-regression.log`：识别器与路由编译器定向测试；新增测试验证 Session 与 WorkItem 状态不同的情况下，原始用户输入不变且真实 Session 状态进入分类上下文。
- `server-typecheck.log`：服务端类型检查。
- `recognition-regression-final.log`：最终提示词修改后重新执行同一组测试，32/32 通过；`optimized-build.log`：优化后服务端构建通过。
- `recognition-regression-round2.log`：第二轮修改后 32/32 通过；`final-build.log`：第二轮服务端构建通过。
- 模型效果以 `report.md` 的完整前后复测为准。单元测试验证上下文传递和编译约束，不能证明模型准确率。
- 基线进程启动于优化代码构建之前，使用旧构建；保留 `baseline-semantic-router.js` 和对应哈希。原始模型消息可核对优化前不含新增会话状态规则。

## 纠错与重试的评测口径

沿用系统现有逻辑：结构错误最多一次格式修复，总识别调用最多两次；无法绑定的目标澄清，错误/未授权路由不执行。本轮不新增工作流重试机制。L20 检查自然语言纠正能否识别正确旧 Decision、版本与原文替换内容；不把识别成功等同于全部执行纠错能力已验收。

本次连接调试记录保留但不计分：首次桥接错误地将 CLI 的配置/网络诊断事件视为工具调用；另一试跑使用了 CLI 不允许覆盖的内置 provider 配置。正式运行去掉该覆盖，并区分诊断事件与真正工具调用。使用本地已配置账号，不修改用户模型连接配置。
