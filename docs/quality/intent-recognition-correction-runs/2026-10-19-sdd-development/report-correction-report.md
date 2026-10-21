# 已发布测试报告的纠错对账与替代

Run ID：`SDD-2026-10-20-report-correction`。依据 Spec IRC-R09/11/13、Plan D05–D08、Task IR08/IR09/IR11.3 的历史效果保护要求。上一轮完成报告授权与发布，本轮继续实现已完成效果的纠错，不将整个专项标为完成。

## 问题与实现

原纠错影响集合主要收集 activeInvocationId；已经完成并发布报告的调用可能不在集合中，后续对账得到空回执，无法说明已有报告如何处理。原对账函数虽然拒绝带 resultArtifactId 的步骤，但没有完整覆盖接收阶段遗漏已完成调用的情况。

现在接收事务同时查找目标路由的已发布报告步骤，将其调用纳入 affectedExecutionIds。结果标记缺失但仍存在对应报告时也必须核验；缺执行身份使用不可满足的核对身份维持屏障，不能按零效果放行。其他路由的历史报告不会被随意关联为替代对象。

对账 v2 区分 `isolated_scratch_discarded` 与 `published_report_retained`。后者校验 session/epoch/WorkItem/step/历史计划/历史授权、固定 runner 身份、停止清理证据、实际退出码和快照；报告正文用与发布完全相同的规范生成函数核对。正文、调用或归属不一致，缺授权凭据，或者存在源码写回，继续进入 reconciliation_required。新回执保存 artifactId 和 Markdown 正文 SHA-256；旧 v1 数据仍兼容。

新版本激活事务再次读取证据，不依赖分类前的旧核验结果。明确重新测试且当前测试/报告权限有效时，新 step 以不可变 supersedesArtifactIds 绑定历史报告；执行结束生成新产物并附上关系，旧报告、内容和原完成/失败状态均保持不变。仅记录新要求的纠错保留报告但不运行测试。报告保存失败重用已持久化 journal，恢复不多跑一次测试。

生效事件说明历史结果未撤销并提供 retainedArtifactIds；Web/Desktop 新报告展示“关联旧报告仍保留”的提示。这是保留历史并产生修订结果，不是删除旧报告，也不是外部系统的补偿或撤回。

## 验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 纠错接收、计划、测试执行器 | 64/64 | report-correction-related-final.log |
| Server 全量 | 2129 通过、0 失败；开发脚本另 7 通过 | report-correction-server-tests.log |
| Shared 全量 | 282/282 | report-correction-shared.log |
| Web 全量 | 497/497 | report-correction-web-tests.log |
| 双端报告组件 | 8/8，包含关联关系及转义展示 | report-correction-ui.log |
| Nest/File + 实际 Docker + 真实重启 | 14/14，含新增 RC01–RC04 | report-correction-final-http-results.json |
| 实际 PostgreSQL 16.13 | 28/28，0 跳过，容器已回收 | report-correction-postgres.log / .json |
| 类型、构建、Harness、diff | 退出码 0 | report-correction-manifest.json 所列日志 |

全量 Server 的 33 跳过为 28 个 PostgreSQL 用例与 5 个可选 Docker 用例。28 个数据库用例已独立在临时数据库运行；HTTP/Docker 是本功能的真实执行证据，不代表五个可选用例也已执行。各测试集合相互重叠，不能累计成独立样本数。

新增服务用例覆盖：成功或失败旧报告的保留；已完成调用进入纠错影响集合；报告内容/归属/调用/状态/授权证明损坏；缺产物或缺结果标记；分类期间证据变化；报告撤权；激活事务失败；替代报告保存失败后 File 重载复用原结果；同键重放和磁盘重载不重复执行。旧报告对象深比较保持不变，新报告保存关联关系，历史 step 不被改写为撤销。

HTTP RC01 观察已完成调用进入对账并返回 published_report_retained；RC02 实际重新运行 Docker，验证新的输出和快照、关联旧报告、原源码不变；RC03 重放并真正重启 Nest 后，报告和测试均没有重复；RC04 取消报告权限后返回 EFFECT_NOT_AUTHORIZED，保留 hold、版本仍为 2，不创建版本 3 步骤或报告。原 TD/TR 十项也一并通过。

PostgreSQL 的两个报告用例在上轮基础上扩展，因此总数仍为 28：独立连接竞争纠错激活只分类/提交一次，关系重载后仍存在；SQL trigger 拒绝新版本插入时，旧报告不变、新 step 不出现、屏障保留。成功分支随后执行替代步骤，旧/新两份产物均可读取。这里使用真实数据库事务和确定性 Runtime 夹具，实际 Docker 证据由 HTTP 场景提供。

## 失败记录与范围

首轮 HTTP 的前 13 项通过，最后一项因只等待 rejected 而超时。现有缺授权策略允许 clarification_required，脚本改为接受这两种停止状态，同时明确断言原因必须为 EFFECT_NOT_AUTHORIZED、屏障仍在、版本不前进且没有新报告。最终 14/14；原 report-correction-http.log 与 results 保留，没有修改产品策略以迎合测试。

最终正文 hash 从整段报告 metadata hash 收敛为 Markdown 正文 SHA-256，避免 JSON 字段顺序影响；最终 Server 全量和 PostgreSQL 覆盖该改动。最终构建后再次执行 HTTP 的源码范围见 manifest。未新增完整浏览器/Electron/SSE 故障评测，前端验证是产品组件测试和构建。

仍缺通用产物/源码/外部效果的对账与补偿、完整首轮 IA03、子任务权限传播、多段计划、CLI/Bridge、完整客户端/进程故障矩阵及独立双人标注准确率验收。IR08/IR09/IR11 和整个发布门保持部分完成；没有提交、部署或更改生产连接。
