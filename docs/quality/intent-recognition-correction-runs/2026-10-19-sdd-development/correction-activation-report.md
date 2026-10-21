# 纠错激活、过期结果接收和写回开发记录

日期：2026-10-19。依据意图纠错四件套以及详细系统开发设计，继续实现 IR03.3、IR08.3/IR08.4、IR09.2/IR09.4 的部分链路。本文接续 `versioned-correction-report.md`，历史日志和 manifest 保留；整个专项、完整 AC 和 G3 均未完成。

## 本次行为

1. 纠错进入 `validating` 后调用新的 `intent_understanding@1.0` 合同。原消息、sourceEventId、目标 WorkItem、原 Decision/revision 由服务端绑定；模型只返回语义数据。识别使用 routing 准入、无工具、无工作区能力、writeMode=none；该入口接通的是纠错分类，普通消息主分类仍待迁移。
2. 在纠错记录内持久化租约、总截止时间、最多两次分类、一次 Schema 修复和一次快照重建。并发 worker 只有一个持有租约；重启和旧 worker 返回不能重置预算。401 不在原连接自动重复；用户明确提交新纠错可以替代 rejected/clarification_required 请求，产生新的版本和逻辑 operation，旧请求仍留审计。
3. 当前可激活 `correct_route`、`record_constraint`、`record_information` 且无执行效果的单段计划。激活事务重验快照、精确证据、目标和原决定 revision，然后同时追加 Decision、supersede 或局部 override、递增 requirementRevision、写入不可变版本/完成步骤/事件/Outbox、释放本次 hold，并取消旧 follow-up。会话不会因此恢复或自动执行。
4. Context 与执行绑定共用有效 Decision 投影与哈希。子任务纠正继承约束只覆盖当前任务；父任务/同级任务保持原约束。后续上下文排除已替代约束；执行准入同时核对持久化计划绑定和当前有效 Decision 哈希。
5. Runtime 接收结果时在保存调用审计的同一事务检查 hold、有效版本、epoch、generation 和绑定。过期成功/失败保留原输出与候选审计，返回无可执行结果的非重试失败；删除/epoch 不符不会从缓存复活调用记录。过期候选和 CLI 会话不作为恢复来源。
6. Orchestrator 在结果返回/事件消费后，以及任务结果投影和等待工作区写回后复核调用。过期结果通过专门内部异常终止；本地 ExecutionService 不触发业务 outcome，队列 worker 不将其当可重试错误，Session 通用失败处理不覆盖新的状态。此处仍不是所有业务投影统一事务，不能据此声明 IR09.2 全路径完成。
7. 工作区写回从持久化调用获取执行绑定，queued/merging/applying 状态提交与当前意图校验共享事务。纠错若先提交，排队写回不能启动；若文件写入已获准开始，纠错接收事务会记录该调用并保留 hold，要求效果核对。已经发生的文件改动不声称已撤销。Session 删除后的终结回执不重新创建写回记录。

## 验证证据与范围

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 纠错/编译/上下文/语义合同回归 | 82 通过 | `correction-activation-regression.log` |
| Runtime/LogicalOperation/纠错/执行服务回归 | 122 通过 | `intent-result-admission-regression-final.log` |
| Orchestrator 与执行服务结果边界 | 96 通过 | `intent-result-orchestrator-regression-final.log` |
| 工作区写回与真实文件竞态 | 20 通过 | `intent-writeback-file-regression-final.log` |
| 全仓 `npm run test` | 2853 通过，0 失败，21 PostgreSQL 跳过 | `correction-activation-workspace-tests.log` |
| 全仓类型检查 | 退出码 0 | `correction-activation-workspace-typecheck.log` |
| 真实 localhost API + Generic LLM HTTP + 进程重启 | CA01–CA06 通过；最终重跑见 manifest | `correction-activation-http-results.json` |

全仓运行后增加一项 Orchestrator 边界测试和一项写回删除保护及测试，分别由上述 96/20 项专项回归覆盖；不把增量虚计入 2853。最终构建、Harness、HTTP 重跑、日志哈希和源码指纹统一记录在 `correction-activation-manifest.json`。各日志包含重叠测试，不能相加作为独立意图题数。

CA01–CA06 使用独立 File 数据和本机确定性 OpenAI-compatible fixture，经过实际 Generic LLM 传输、严格合同解析、API 接收/并发/激活、旧约束失效和服务进程重启。服务运行期间仅通过 API 提交纠错；原 Decision/route fixture 在停服状态通过领域服务生成。该验证不是实际模型语义准确率，也不证明 Codex/Claude sandbox。HTTP fixture 不修改用户 `.env` 或现有模型配置。

真实文件测试使用临时目录和 ServerLocalWorkspaceProvider，检查目标文件内容和 provider 调用次数；同时覆盖无关 WorkItem 可继续、排队旧写回零文件效果、已准入写入等待核对以及删除后不复活记录。File 同一进程事务通过不代表 File 跨进程互斥或 PostgreSQL 并发通过。

## 失败与修正记录

- 初始测试直接赋值只读语义合同字段，类型检查/构建拒绝；改成构造新的非法输出对象，保留攻击场景断言。失败日志 `correction-activation-typecheck.log`、`correction-activation-build.log` 保留。
- 初始 HTTP fixture 对等待 Brief 确认的会话调用 pause，状态机返回 400；删除不合法前提，改为验证纠错前后会话状态不变。服务测试另外覆盖真实 PAUSED 状态不恢复。
- HTTP fixture 创建的原始路由未显式带 routingRevision，严格请求因缺必填版本返回 400；使用兼容基线版本 1。未放宽服务端请求校验。
- 初次 Runtime 守卫复制 InvocationPlan，破坏已有操作预算与 Adapter 对象身份的约定，5 项回归失败；恢复原计划对象并保留新增 epoch 绑定，122 项重跑全部通过。失败日志 `intent-result-admission-regression.log` 保留。
- 第一次 Orchestrator 专项进程只输出 TAP 头、退出码 1，没有形成测试结论；全仓完成后顺序重跑得到 96/96。该失败日志保留，不作为通过证据。

## 尚未完成

普通聊天纠错入口、无原 WorkItem 的纠正、多段执行及效果复用、执行型纠错的计划调度、已发生外部效果的对账/后续修正仍需实现。旧主路径、首轮统一意图入口、实际测试/源码/产物权限执行器、完整任务/产物/Workflow/GitHub 结果投影事务与所有迟到回调仍未收敛。跨进程写回与混合 worker 还需环境验证；仅新增接收守卫不等于全过程原子隔离。

IR10 双端纠错界面、真实 Electron/CLI、PostgreSQL 集成、完整 58 场景、独立 500+ 双人标注和灰度/回滚门继续待完成。`ordered_plan` 保持关闭；没有提交、发布、部署或生产数据迁移。本次实现不降低原 Spec 的验收范围。
