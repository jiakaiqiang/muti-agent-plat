# 阶段 6 策略准入与发布交接 v1

> 状态：交接工具已实现；当前准入仍被未完成验收和缺失授权阻断。

## 目的

在不连接业务数据库、不启用策略、不发布服务的前提下，生成脱敏的阶段 6 准入判定。工具只输出允许列表中的枚举、布尔状态、证据计数和阻断原因，不输出数据库 URL、密钥、价格目录正文或授权标识。

## 入口

```powershell
npm run phase-6:release-preflight
```

真实模型抽样（以及以后启用计费/费用预算时的专项验证）在发布 preflight 之前另有只读门禁：

```powershell
npm run phase-6:live-model-preflight
```

该入口会只读加载仓库根目录 `.env`，但只输出布尔状态、允许列表枚举和阻断 ID。只有要执行受控真实模型抽样时，才要求 `PHASE_6_LIVE_MODEL_APPROVAL_ID`、`PHASE_6_LIVE_MODEL_DATA_SCOPE=synthetic_fixture_only`、正整数 `PHASE_6_LIVE_MODEL_MAX_CALLS`、正数 `PHASE_6_LIVE_MODEL_MAX_COST_USD`、完整 OpenAI-compatible Provider 配置以及（若要生成美元估算）精确版本价格条目同时满足。它本身不会联网或执行模型调用；普通会话、usage 采集和未启用计费的发布流程不依赖该门禁。

获得本次真实模型调用和数据范围的明确授权后，才可单独执行 `npm run phase-6:live-model-evaluation`。若没有价格条目，评估可以采集真实 usage/缓存/TTFT/耗时，但美元费用仍为 unknown；只有后续计费专项明确启用时才要求价格与费用上限。入口不使用 `DATABASE_URL`，使用完成后清理的隔离 file 状态；只在门禁 ready 后通过平台 `RuntimeService` 调用模型。证据位于 `.cache/agent-cluster/phase-6/live-model-evidence.json`，仅记录脱敏指标，可用 `npm run phase-6:cost-report` 合并到报告。自动回归仅使用本地 fake Provider，不会运行上述真实入口。当前尚无真实调用授权，不执行真实入口。

返回 `ready` 需同时满足：

- 追踪矩阵无 partial、pending、not-executed、failed 或 missing。
- `test:e2e:phase-6-migration-postgres` 成功生成 `.cache/agent-cluster/phase-6/postgres-migration-evidence.json`。
- `AGENT_CLUSTER_COMMIT` 和 `AGENT_CLUSTER_BUILD_TIME` 均已配置。
- 操作人在获得本次独立授权后填写 `PHASE_6_RELEASE_APPROVAL_ID`；该值只判断是否存在，不写入报告。
- 如强制启用 `INTENT_ROUTING_MODE=enforce_*`、开启 `MAIN_AGENT_DISCUSSION_ENABLED` 或开启 `REQUIREMENT_DOCUMENT_ENABLED`，上述验收、rollback、构建身份和授权必须全部通过；否则 fail closed。

计费边界：价格目录、美元估算、费用预算和账单核对均为后续专项。价格目录缺失表示计费未启用，不阻断普通服务、会话、Agent 调用或 usage 采集；只有显式提供非法价格目录时才 fail closed，避免产生错误账单。

`RELATIONAL_TEST_DATABASE_URL` 只用于隔离演练，工具不会回退到 `DATABASE_URL`。配置 URL 不等于验证完成，准入只认成功演练后生成的证据文件。

## 发布边界

`ready` 只表示软件门禁和交接元数据齐备，不会自动修改环境变量、启动进程、迁移数据、调用真实模型或发布任何服务。正式发布仍按 [CI 与发布 Checklist](./ci-release-checklist.md) 逐项执行，并在当前会话取得明确授权。

服务启动也使用相同的准入判定：启用 `INTENT_ROUTING_MODE=enforce_*`、`MAIN_AGENT_DISCUSSION_ENABLED` 或 `REQUIREMENT_DOCUMENT_ENABLED` 中任一项时，先读取追踪矩阵和 PostgreSQL rollback 证据；即使部署漏设 `NODE_ENV=production` 也不能绕过。矩阵汇总与逐条 AC 状态不一致、缺文件、内容无效或任一门禁未通过即在监听 HTTP 前以 `PHASE_6_POLICY_ADMISSION_BLOCKED` 拒绝启动。默认路径相对服务工作目录；独立部署时可显式配置 `PHASE_6_TRACEABILITY_PATH` 与 `PHASE_6_POSTGRES_EVIDENCE_PATH` 指向随构建交付的验收文件。仅仓库隔离 smoke 可同时使用 `NODE_ENV=test` 与 `PHASE_6_POLICY_ADMISSION_BYPASS=isolated_test_only`；其他环境或其他 bypass 值均不放行。未启用新策略的服务不依赖阶段 6 验收文件。
