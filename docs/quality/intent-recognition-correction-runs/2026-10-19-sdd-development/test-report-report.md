# 隔离测试报告授权与事务发布

Run ID：`SDD-2026-10-20-test-report`。依据四件套 IRC-R03/11/13、IR05.2/4、IR09.2 和 IA03。已经进入实现；本次完成既有 WorkItem 的隔离测试报告链路，整个意图识别专项仍在开发中。

## 实现行为

- 测试授权 API 新增可选 `writeReport`。true 签发独立报告授权；false/省略仅保留测试授权；revoke 撤销两者。报告资源绑定当前 runner 的 bindingHash、grant revision 和来源事件，不能从历史版本或模型输出恢复权限。同键重试核对原操作并返回当前状态。
- 已提交的单步骤计划可请求 `run_tests + write_artifact`，两项分别校验授权。报告必须对应同一 runner，禁止独立任意产物写入、额外源码效果或重复效果。容器仍只具备 test/run_test、writeMode=none；报告由服务器根据实际持久化日志生成。
- 结果发布事务重验当前意图版本、epoch、generation、授权、物理执行身份和停止/清理证明。同事务保存 Artifact、resultArtifactId、结果事件和 Outbox。数据库写入失败保留原日志，恢复只补发布，不重跑测试。
- 报告包含实际 snapshotHash、script、退出码和 stdout/stderr，每路最多 16000 字符并标识截断。正常非零退出码保存失败报告，步骤仍为 failed；超时、取消、内存限制、清理不确定或缺快照证明不发布报告。
- Web/Desktop 使用共享授权面板勾选“允许保存会话测试报告”，原请求及勾选状态可在当前标签页刷新后恢复。两端时间线折叠展示转义后的报告文本；输出中的 HTML 不执行。
- 已发布报告是历史产物，不能宣称它随 scratch 一起被丢弃。纠错对账遇到已发布报告继续拒绝自动放行；完整的报告替代/撤回与补偿流程仍未完成。

## 验证结果

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| Server 全量 | 2123 通过，0 失败；开发脚本另 7 通过 | test-report-server-tests.log |
| Shared 全量 | 282 通过 | test-report-shared.log |
| Web 全量，含双端组件 | 497 通过 | test-report-web-tests.log |
| 授权、执行器、journal、InvocationResolver | 79 通过，4 可选 Docker 跳过 | test-report-related-final.log |
| 最后失败文案增量 | 执行器 21/21 | test-report-executor-final.log |
| 实际 Nest/File + Docker + 真实重启 | TD01–TD07、TR01–TR03，共 10/10 | test-report-http-results.json |
| 真实 Chromium 共享面板 + 隔离 API | RU01–RU06，共 6/6 | test-report-ui-browser.log |
| 真实临时 PostgreSQL 16.13 | 28/28，0 跳过，容器已清理 | test-report-postgres-verified.log / .json |
| 类型、构建、Harness、diff | 退出码 0 | test-report-manifest.json 所列日志 |

全量 Server 的 31 跳过是 26 个既有 PostgreSQL 用例和 5 个可选 Docker 测试。随后加入的两个报告数据库用例与原 26 项共同在真实数据库通过；独立 HTTP/Docker 覆盖本切片，不把五个可选跳过视为已经执行。不同集合有重叠，不能相加当作独立测试总量。

HTTP 使用实际容器验证只读源码挂载和可写 scratch；报告内容可由真实产物 API 读取，服务重启不重复执行或保存。运行中撤权确认停止后，不发布旧报告；重新授权不复活旧步骤。只取消报告权限后，含报告的请求被阻止，新的测试单独请求仍可执行；源码文件内容不变，workspaceWritebacks 为空。退出码 3 的测试保存失败报告，不发成功完成事件。

数据库新增用例使用独立 Persistence 连接和服务层真实事务，Runtime 结果由确定性夹具提供。SQL trigger 拒绝 artifacts 插入时，报告、事件、Outbox 和完成标记全部回滚；移除 trigger、过期旧租约后另一连接复用 journal 发布，Runtime 调用仍为一次。该数据库测试没有启动实际 Docker；Docker 执行证据来自上面的 HTTP 场景。

浏览器验证勾选与单独移除报告权限、服务端提交后丢弃响应、刷新恢复勾选并冻结请求、重试返回 idempotentReplay、390px 无横向溢出及 Space 键操作。最终四条授权事件、无测试调用、仅保留测试授权。截图为 `output/playwright/test-report-ui-mobile.png`，已检查布局。此处验证共享产品组件，不等同完整 Electron 进程或双客户端故障矩阵。

## 失败记录与验证范围

最初两个 PostgreSQL 用例被夹具留下的 RECEIVED 路由阻止，诊断日志确认顺序门生效；修正为先终结无关的夹具输入后，新用例又因未注入测试派发器而正确 blocked。补齐夹具派发依赖后 28/28。前缀 `test-report-postgres`、`test-report-postgres-diagnostic` 和 `test-report-postgres-final` 的失败日志/数据库清理结果保留，最终成功证据使用 `test-report-postgres-verified`。没有放宽生产守卫。

全仓构建早于失败报告分支补充，HTTP 前另一次 Server 构建覆盖该分支。Server 全量运行后仅新增失败通知文案和两项 PostgreSQL 测试；最后执行器 21 项、真实数据库 28 项和 Server 最终构建覆盖增量。源码与命令指纹见 `test-report-manifest.json`。

## 未完成范围

这是服务器生成的受限测试报告，不是任意 Markdown 文件写入、通用报告执行器或源码编辑器。IA03 还包含首轮评测流程，IRC-AC03 还包含 Workflow/子任务权限传播及其他写入场景，因此仍不整体勾选。完整纠错补偿、多段计划、特殊入口、CLI/Bridge、Electron/数据库 HTTP 故障矩阵及独立人工标注准确率评测仍待完成。未提交、部署或修改生产模型连接。
