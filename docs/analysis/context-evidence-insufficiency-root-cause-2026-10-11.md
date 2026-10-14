# 上下文证据不足：根因、架构缺陷与修复

日期：2026-10-11。

## 范围与验收

本次处理工作区索引查询、源码证据筛选、补读一致性、本地只读调用版本校验与启动提示。继续采用索引导航和按需读取，不扩大为全仓库正文注入，不关闭证据门禁，不放松写回保护。

验收要求：中文架构请求能选出嵌套项目入口；虚拟环境与二进制内容不能作为源码证据；补读期间产生的新版本证据不能被批次起始版本误删；无关版本变化可通过文件 hash 验证恢复只读分析；真正的证据变化和写操作仍受版本冲突保护。

## 原始故障事实

检查会话 `a09ea59c-e91a-4ff3-8ce7-3011746052ef`，需求是“分析一下当前项目中的架构以及每个功能点之间的关联关系”，业务目录为 `jkq-agents`，执行位置是本地 Claude Code。

- 历史索引记录 9840 个条目，查询返回 17 个候选，入口和技术栈为空。
- 候选集中在 `analysis` 路径，包括 `python/.venv/Lib/site-packages/mypyc/analysis/` 和 `.pyd` 二进制文件。
- 两次补读提示 `evidence-empty`。首次补读结果携带多个不同的工作区 revision。
- 最终上下文有 6 份文件正文，其中 3 份是 `.pyd`；正文 51,379 字节，证据预算为 224,000 字节。
- 最终错误是 `LOCAL_WORKSPACE_REVISION_CONFLICT: workspace changed after invocation planning.`，位置在本地适配器启动前。平台的 `runtime_started` 事件不等于模型已经启动。
- 没有本次发生 token 超限的证据。现有日志不能确定触发历史 revision 变化的具体文件事件。

2026-10-11 排查时，持久化索引为 9843 条，其中 9474 条属于 `.venv`。这个当前统计与历史调用时的 9840 条需要区分。

## 架构缺陷

### 1. 意图路由与证据检索混用了同一个字符串

`analysis` 是任务意图，却被作为路径搜索关键词。中文需求经过仅保留英文数字的切词后，实际只剩意图枚举参与匹配。业务源码已经存在于索引中，却未进入任务导航投影。

修复：共享的 `queryWorkspaceNavigation` 不再将 intent 当成文件关键词；支持 Unicode 与中文分词，架构请求保留结构候选；显式路径和符号仍可参与检索。

### 2. 索引可导航性被误当成业务证据质量

原入口探测仅识别根目录清单，遗漏 `python/pyproject.toml`、`typescript/package.json`。目录排除规则也遗漏 Python 环境与缓存。二进制文件只要存在于非敏感导航中，就可能通过证据门禁。

修复：本地和服务器索引复用嵌套清单识别和候选策略；排除虚拟环境、Python 缓存；导航、自动补读、L3 编译和门禁检查文件路径及文本有效性。显式文本读取拒绝二进制，同时保留合法源码中的 ANSI 字符和受控方案文档读取。

### 3. 全局目录版本与文件正文有效性过度绑定

原补读流程在批次开始获取 R1，读取期间取得 R2 的新文件，最后却用 R1 清理缓存，导致刚读到的证据被删除。上层还可能把已经没有正文的路径报告为补读成功。

修复：以批次结束版本整理缓存；对早先读取的文件仅在 hash 重新验证相同后更新证据 revision；剔除的正文不能出现在成功补读清单中，并明确记录可重试失败。L3 仍要求版本一致，不盲目给旧正文贴新版本。

### 4. 只读分析和写操作使用了相同的失败策略

只读分析在发起调用后遇到任何全局 revision 变化，也会在本地模型启动前失败，即使所选证据文件内容完全未变。

修复：只对 `writeMode=none`、非 task_execution、无修订候选的调用，允许最多 32 个带完整 hash 的证据文件重新验证。源文件和隔离副本都需匹配原 hash；原 Context Envelope 保持冻结。证据变化、无 hash、空证据、写操作仍拒绝放行。

### 5. 可观测事件早于真实模型启动

平台在分发前发出“已开始执行”，导致本地准备失败被误认为模型处理失败。

修复：平台提示改为“正在准备调用，等待本地校验或模型启动”；成功重新验证证据的只读调用会记录明确进度事件。事件枚举和既有客户端状态合同不变。

## 修复后的数据流

```text
用户目标 / 意图
  -> 目录元数据索引（排除依赖和缓存）
  -> 中文/路径查询 + 嵌套项目清单 + 结构候选
  -> 有界导航与项目地图
  -> 按优先级补读正文
  -> 批次结束版本 + 文件 hash 验证
  -> L3 文本证据门禁
  -> 本地版本预检（只读可按 hash 恢复，写操作保持严格）
  -> 模型适配器
```

## 验证证据

- 全仓库 `npm run typecheck` 通过。
- shared、server、local-runtime-cli 构建通过。
- 后端定向测试 131 项通过：编排/补读、Context Router、证据门禁、Envelope、导航清单、服务器索引、文件读取。
- 本地 Runtime 与共享策略定向测试 49 项通过：真实目录扫描、嵌套入口、二进制检测、只读 hash 重验证及适配器调用边界。
- 使用同一业务目录的真实持久化索引和原始中文请求回放：返回 50 个有界候选，入口为 `CLAUDE.md`、`python/pyproject.toml`、`typescript/package.json`；候选无 `.venv`。
- 前 8 个补读文件包括上述清单、`typescript/src/main.tsx`、`python/src/mewcode/__main__.py`、两端 TUI app 与 Python CLI；读取正文 18,302 字节，源码证据门禁通过。
- 重载本地开发后端和独立 Runtime 后，在线工作区索引为 ready、299 条，识别 Node/Python 技术栈及上述三个入口。后端健康状态为 ok、构建未过期，前端 API 代理返回 HTTP 200。

真实模型未在本次验证中调用，原历史失败会话未自动重跑。定向测试不能替代所有业务流程的端到端验收。当前候选策略仍是有界启发式导航，不承诺读取全部文件或自动完成所有语言的语义依赖分析。

## 主要实现入口

- `packages/shared/src/workspace-evidence-policy.ts`
- `packages/shared/src/workspace-ignore.ts`
- `packages/local-runtime-cli/src/workspace.ts`
- `packages/local-runtime-cli/src/runtime.ts`
- `apps/server/src/modules/workspaces/server-local-workspace-index.ts`
- `apps/server/src/modules/orchestrator/context-router.service.ts`
- `apps/server/src/modules/orchestrator/orchestrator.service.ts`
- `apps/server/src/modules/context-v2/grounded-evidence-gate.ts`

本次依据项目地图、Harness 执行协议、工作区索引/按需取证设计和实际会话记录实施。未新增业务审批、数据库或第二套上下文系统。
