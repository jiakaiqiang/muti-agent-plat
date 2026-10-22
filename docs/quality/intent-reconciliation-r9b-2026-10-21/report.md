# M-008：PostgreSQL 补验与 R9b 双端对账卡片

日期：2026-10-21。基线 HEAD：`5ded5262d39b20a0d4c2dfe3cd8a5457faa1b4c2`。

## 1. 交付与范围

按 M-008 先完成 A 再实施 B。Web 和 Desktop 已在现有 ConfirmationCard／ChatTimeline／SessionWorkspace 中接入人工对账卡，共用 Web 的 session/event store、类型和卡片实现，只调用 R9a 已有 GET／POST，没有新页面或后端行为。只在新链路会话加载案件；现有默认开关未调整。

每项事实按服务端记录展示，附记录来源和观测时间；核心缺失字段、缺失时间及工作区归属显示“未知”，空记录显示“未记录”，明确提示“未记录不代表未执行”。原绑定及授权版本作为证据展示，不推断执行成功。三个动作按服务端 availability 禁用并显示原因；来源为 correction／isolated_test／其它 plan_step 的案件仅显示证据、服务端 handler 标识及返回原处理入口的指引，不显示三动作或 CLI 勾选框。

CLI 重新派发必须勾选“工作区改动由我负责”，仅 redispatch 请求带 `acceptWorkspaceResponsibility: true` 与 `riskVersion: intent-cli-workspace-responsibility-v1`，证据／会话版本变化后清除勾选。卡片明确提示“当前新链路还不支持在该运行时上执行，选择后可能仍被阻止”。没有放宽 `intent-runtime-policy.ts`。

同案件在两处显示时共用提交锁；提交时禁用动作。请求携带服务端案件／会话 revision，幂等键由案件身份、案件版本、会话版本、动作和 CLI 确认版本固定生成，因此同一请求在传输重试和页面刷新后仍使用相同键。GET 使用 no-store；409 后重新 GET，不自动 POST；若已有读取在途，等待结束后再发新读取。读取失败或响应无效时禁用动作，保留明确错误。事件只触发事实刷新，持久化案件是当前卡片／历史决定的来源；即使原确认事件不在已加载历史中，也可恢复卡片，并对同案件重复事件去重。

## 2. A：PostgreSQL 实库补验

利用原已运行容器，凭据仅经子进程环境传递；未输出凭据或连接 URL。四个 spec 串行执行，每个分配新建一次性库，在 finally 中删除；R9a spec 另按自身约定创建并删除独立库。主库连接强制只读，没有对主库执行测试或迁移。

| 集成文件（server persistence/relational） | 通过 / 总数 |
| --- | --- |
| intent-reconciliation.integration.spec.ts | 1 / 1 |
| intent-correction.integration.spec.ts | 1 / 1 |
| intent-semantic-transactions.integration.spec.ts | 15 / 15 |
| postgres-migration-runner.integration.spec.ts | 20 / 20 |
| 合计 | **37 / 37，0 失败，0 跳过** |

| 主库 agent_cluster 的只读指标 | 测试前 | 测试后 |
| --- | --- | --- |
| 会话数 | 16 | 16 |
| deleted_at 非空会话数 | 4 | 4 |
| 最新迁移版本 | 22 | 22 |

脱敏完整日志：`../intent-reconciliation-r9a-2026-10-21/evidence/postgres-integration.log`；R9a 原报告末尾已追加补验，原证据未覆盖。这里证明的是上述集成用例和三项指标，不把它等同于全部生产数据一致性或真实 Runtime 效果验证。

## 3. B：验收与日志

先新增双端组件用例再实现：初跑 18 项新增用例失败、14 项既有用例通过，见 `evidence/components-red.log`。实现后的最终候选结果如下。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Web ConfirmationCard | 21 / 21 | frontend-regression-2.log |
| Desktop ConfirmationCard | 21 / 21 | frontend-regression-2.log |
| 卡片＋ChatTimeline＋SessionWorkspace＋事件／会话回归 | **11 文件，103 / 103** | frontend-regression-2.log |
| Web vue-tsc | exit 0；最终 build 再次检查 | web-vue-tsc-2.log、web-build-final.log |
| Desktop renderer vue-tsc | exit 0；最终 build 再次检查 | desktop-vue-tsc-3.log、desktop-build-final.log |
| Web build | exit 0 | web-build-final.log |
| Desktop build（含 renderer 与 main/preload/runtime-worker） | exit 0 | desktop-build-final.log |

双端共享的 14 项新增用例各跑一遍：未知／未记录与来源时间、服务端禁用原因、CLI 必填与请求字段、重复点击、传输失败幂等、两张卡共用锁、非①动作不带 CLI 字段、证据变化重勾、坏响应阻止、刷新恢复历史、三种只读来源、409 重读且零自动重投、409 后刷新失败阻止、重复持久化事件去重及关闭状态恢复（部分验收合并在一个用例）。

复现命令（仓库根目录）：

```powershell
npm run test --workspace apps/web -- src/components/ConfirmationCard.spec.ts ../desktop/renderer/components/ConfirmationCard.spec.ts src/components/ChatTimeline src/components/SessionWorkspace.spec.ts src/stores/event-normalization.spec.ts src/stores/event-connection.spec.ts src/stores/session-navigation.spec.ts src/stores/session-intent-routing.spec.ts
npm run typecheck --workspace apps/web
node apps/web/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/desktop/renderer/tsconfig.json
npm run build --workspace apps/web
npm run build --workspace apps/desktop
```

早期类型检查发现恢复消息缺 rawEventId，已补齐，保留失败日志；首次 Desktop 检查命令误用了根 node_modules 中不存在的 vue-tsc 路径，随后使用 Web 安装路径通过。两端构建保留 Vite 的大 chunk 提示，未调整打包配置。每次测试／构建后及写报告前已读取监督 inbox，本轮未发现其它 OPEN／STOP 条目。

## 4. 文件与冻结

设计 §6 已列文件：两端 `components/{ConfirmationCard,ChatTimeline,SessionWorkspace}.vue`，共用 `apps/web/src/{types/contracts,stores/session,stores/event}.ts`。另新增共享 `IntentReconciliationCard.vue` 与 `intentReconciliationModel.ts`，避免两端重复证据、确认和幂等语义；共享 `intentReconciliationCard.test-support.ts`，由两端原 ConfirmationCard.spec.ts 分别运行同一验收合同。

`evidence/verification.json` 保存 14 份源码、两端实际构建文件逐项哈希、验证结果和证据日志哈希。聚合方法为路径排序的 `{path,sha256}` 数组 `JSON.stringify` 后计算 SHA-256。

| 项目 | SHA-256 |
| --- | --- |
| 14 文件 source 聚合 | `f49f251806d6e28c20f912640d7d61df4efaf8b51a6f57729cd472b5dd5ee8f4` |
| Web dist 聚合 | `48709eb6ee76f79c1e242b269fb290ce667dcf66134e82675c82418bd9c036e9` |
| Desktop dist 聚合 | `4f919557ee0d30db6eaa30deb954cb2b6b7093c58e87e7be9d02a49add31cf4f` |
| verification.json | `4e275f476713b363cc8f6002066b45970dcabb4dc4aaa1a0a7a1525fad348b9c` |

对本轮前保存的 server/src、shared/src、server/dist、`.env` 共 **2,297 文件**逐项实算哈希，0 差异；同时复核 R9a 的 28 source、28 dist 及 9 个保护文件全部一致。原 R9a 未提交改动和监督方文档保留。未提交、未推送、未运行真实模型。

## 5. 已知边界

- CLI 的独立效果能力策略仍可阻止实际启动；勾选仅提交用户决定，不保证执行成功。
- 观测时间／工作区归属／停止与候选信息以已有服务端证据为限，缺少事实继续显示未知；没有新增扫描或自动对账。
- 原处理器按服务端 handler 标识与指引展示，未创建通用纠错、隔离清理或 plan-step 执行功能。
- 前端验收使用真实 Vue 组件和 mock HTTP；本轮没有跑完整浏览器／Electron 实机业务链或真实 CLI／模型，不将组件通过视为这些已验收。服务端代码不变，因此未额外重跑 server 全套 spec/typecheck/build；A 仅补验指定 PostgreSQL 集成文件。

M-008 交付后停止，等待监督方复核。
