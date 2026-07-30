# Context v2 会话与证据链修复开发计划 v1

## 1. 目标

解决三类同源问题：前端仍连接旧进程/旧数据源导致历史会话继续出现；架构分析的 L3 Evidence 正文为空；补充上下文读取失败或延期后被错误去重，造成等待、空重试或重复请求。

适用本地、测试和生产。产品运行只允许 Context Pipeline v2；旧会话从活动数据集清除，切换前生成外部加密只读归档，且永远不能 resume。

## 2. 开发批次

| 批次 | 内容 | 验收证据 | 状态 |
| --- | --- | --- | --- |
| P0-1 | 严格解析 `requestedContext`，记录 hydrate 成功/失败/延期，成功后才去重 | normalizer、retry、dedupe、router、orchestrator 单测 | 已实现 |
| P0-2 | cutover apply 前生成活动根之外的 AES-256-GCM 只读归档 | 加密 round-trip、hash、权限、根目录隔离、file/PostgreSQL cutover 测试 | 已实现 |
| P0-3 | Health 暴露 PID/启动时间/commit/backend/location；前端 pipeline/schema/commit 闸门 | Ops 与 Web 版本闸门测试 | 已实现 |
| P0-4 | 删除 `fitContextToBudget` 的 `ultra-minimal/navigation_only` 旧链路 | 源码搜索、token 单测、v2 grounded evidence 测试 | 已实现 |
| P0-5 | 强化架构与数据流 Evidence 路由，防止嵌套 demo index 挤掉核心模块 | `ai-langchain` 路径回归测试 | 已实现 |
| P1-1 | 同步产品、设计、Harness reference 和运维文档 | Harness/doc 检查 | 已完成 |
| P1-2 | 全量 typecheck/test/harness/build 和完成审计 | 四个仓库质量门及需求矩阵 | 已完成 |
| OPS | 停止旧进程、真实 dry-run/apply、部署、提交 | 独立高风险授权和操作记录 | 未授权，不执行 |

## 3. 发布顺序

1. 在隔离 file/PostgreSQL 数据上通过 dry-run/apply/idempotency 和归档验证。
2. 构建前后端同一 commit，设置 `AGENT_CLUSTER_COMMIT` 与可选 `VITE_AGENT_CLUSTER_COMMIT`。
3. 从 Health 核对旧进程 PID、实际 backend/location 和 dataEpoch。
4. 获得独立授权后进入维护、停止旧进程/队列、对真实数据 dry-run，再按 token apply。
5. 启动 v2 服务并确认 Health、空活动 Session 列表、新 dataEpoch 和归档 manifest/hash。
6. 创建新架构分析 Session，验证入口、模块数据流正文和补读 resolution。

## 4. 回退边界

代码发布可以回退；dataEpoch cutover 不恢复旧 Session。旧数据仅在外部加密只读归档中用于离线审计，不能重新导入活动数据源。apply 前任何归档/校验失败都保持旧活动 state 和维护模式。

## 5. 验证结果（2026-07-13）

- `npm run typecheck`、`npm test`、`npm run test:harness`、`npm run build` 全部通过。
- file cutover 10 项、PostgreSQL cutover 9 项、v2 startup gate 8 项全部通过。
- large-workspace grounded spec、真实服务 smoke、context-pipeline-v2-only smoke、server-local project analysis smoke 全部通过。
- 对 `D:/demo/ai-langchain` 的只读实测扫描 181 个条目、加载 80 个正文；最终 L3 为 46,112 bytes，包含入口、`shared/model`、chain、RAG loader/retriever/vectorStore/pipeline、Agent、Memory、Prompt、Tool 与 Nuxt 页面。
- 当前 8099 仍由旧 PID 48020 提供服务，Health 不含 v2/schema/dataEpoch 字段；8089 旧前端 PID 35680 仍在监听。真实 cutover、停旧进程和部署未获独立授权，因此没有执行。
