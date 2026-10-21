# 报告执行前置：产物事务存储

Run ID：`SDD-2026-10-20-artifact-transaction`。依据 Spec IRC-R03/11/13、Task IR05.2/4 与 IR09.2 的报告效果隔离和事务一致性要求。专项保持实施中。

## 问题与改动

`ArtifactsService` 原先持有独立 Map，每次创建把整个旧缓存写回集合，且未等待持久化就返回成功。新意图执行器若在自己的事务中发布报告，随后旧服务创建其他产物可能覆盖该报告，或在存储失败时先发布成功事件。本增量先消除这个前置问题。

- 创建改为异步 `mutateCollections`，从事务内最新集合追加；校验当前会话、data epoch、归档/取消和删除生命周期。持久化失败向调用者抛出，不返回乐观成功对象。
- 新增 `appendArtifactInDraft`，供后续计划执行器把产物、计划步骤和 Outbox 放在同一事务。相同产物身份及内容幂等，身份冲突拒绝覆盖。该 helper 本身不授予效果权限，调用者仍须验证计划与授权。
- 查询移除服务独立 Map，读取当前 Persistence 投影；删除也改为集合事务。其他事务在同一 Persistence 实例提交的产物立即可见。跨进程实时查询缓存同步不在本增量范围。
- Orchestrator 和 DiscussionDocuments 创建点等待产物持久化后再使用其 ID/发布事件；历史报告启动恢复移至异步 `onModuleInit` 并等待完成。既有业务事件仍由各调用者发布，没有把旧路径全部宣称为产物/事件同事务。
- `.gitignore` 的 `artifacts/` 原来连 `apps/server/src/modules/artifacts/` 源码也忽略。增加仅该源码目录的例外，既有 controller/module 与修改后的 service/test 可以被 Git 审查；未暂存或提交。

## 验证结果

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| Artifact、Orchestrator、DiscussionDocuments、Sessions | 262 通过、0 失败 | `artifact-transaction-related-verified.log` |
| Server 全量 | 2117 通过、0 失败、31 跳过；开发脚本另 7 通过 | `artifact-transaction-server-tests.log` |
| 真实 PostgreSQL | 26/26，0 跳过，临时容器回收 | `artifact-transaction-postgres.log`、`artifact-transaction-postgres.json` |
| Server 最终构建 | 退出码 0，先于 HTTP | `artifact-transaction-build.log` |
| 真实 Nest/File HTTP 与服务重启 | AS01–AS04 全通过 | `artifact-transaction-http-results.json`、`artifact-transaction-http.log` |
| Harness、diff | 退出码 0 | `artifact-transaction-harness.log`、`artifact-transaction-diff-check.log` |

31 个全量跳过包括 26 个 PostgreSQL 用例和 5 个可选 Docker 测试；26 个数据库用例随后/独立在真实临时 PostgreSQL 中通过，不用跳过结果冒充通过。相关测试和全量测试有重叠。

新增 File 测试验证：事务外创建的报告能被旧服务实例读取；后续两服务并发创建保留所有产物；存储失败无缓存假结果；取消/归档/epoch/删除条件阻止创建；相同 ID 重放去重、不同内容拒绝覆盖。新增 PostgreSQL 测试使用两个独立连接并发创建，重载后均存在，删除后旧连接不能复活产物。

HTTP AS01 验证异步 Brief 产物可读；AS02 验证方案文档同键并发复用且产物/实际文件可读；AS03 验证新版本保留既有产物；AS04 验证真实服务重启后仍可读取。使用旧入口和 mock Runtime，验证兼容性，不是新报告执行器或真实模型准确率测试。

早期 `artifact-transaction-related-final.log` 四项失败源于新 File fixture 缺 schema v3 metadata，补齐后 262/262；早期类型日志记录同步返回值迁移过程。失败证据保留，不计为通过。

## 未完成与下一步

这是报告效果执行的存储前置，不是 `write_artifact` 执行器。尚未增加报告资源授权、计划效果组合、实际报告发布和客户端展示，不能勾选 IA03/IRC-AC03。下一步应将服务器生成的受限报告资源及授权加入快照/编译/执行守卫，在测试结果或报告结果事务中调用新 helper，并验证报告存在、源码 hash 不变、撤权/纠错后无旧报告发布。源码、外部效果、完整多进程故障/双端及独立准确率验收仍待完成。
