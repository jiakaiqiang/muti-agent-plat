# 阶段 2A：统一消息意图、需求隔离与完整 Token 预算 — Checklist v1

> 日期：2026-09-16（2026-09-17 回填证据）
> 状态：**实施中，尚未通过**。T1–T4 完成；T5、T6 未开始。
> 依赖：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P2A-AC1 | P2A-T1、P2A-T6 | 双端重复提交同一消息只产生一个业务路由；含“不要停止”的普通句子不误判为停止命令。 | 部分验证（单测）：message-ingress 透传并持久化 replyTo、reply 目标越界拒绝、幂等重放保留目标；deterministic-guard 不捕获自然语言命令、精确 continue 命令不调用模型。**双端重复提交 E2E 未执行。** |
| P2A-AC2 | P2A-T1、P2A-T2、P2A-T6 | 构造多意图语料与“这个也加上/按上次方案/继续”案例，检查目标与动作；无绑定的确认不能批准任意待办。 | 部分验证（单测）：semantic-intent-router 对模型创建的 WorkItem 引用 fail closed 并澄清、两次 Runtime 失败转为澄清、golden dataset 走同一验证路径。**多意图语料 E2E 未执行。** |
| P2A-AC3 | P2A-T1、P2A-T2、P2A-T3、P2A-T6 | 一千条旧消息/一百个历史需求不被整包注入；用户 @ 质量 Agent 时保留明确目标，非成员走选择/加入确认。 | 部分验证（单测）：intent snapshot 只带有界近期对话与有界候选、快照 hash 覆盖目标字段、分类器输入携带 @、静默丢弃 @ 的目标不被自动应用。**千条消息规模验证未执行。** |
| P2A-AC4 | P2A-T2、P2A-T3、P2A-T6 | A 中的私有需求片段不进入 B；独立需求不继承旧约束；含指令的文件/聊天不能扩大工具权限。 | 部分验证（单测）：L0 信任边界在装配出口强制、被污染装配显式失败而不升级为 L0；WorkItem 切片排除同会话其他需求；独立路由在模型选中旧上下文时仍建干净 WorkItem。 |
| P2A-AC5 | P2A-T4、P2A-T6 | 长中文、长 schema、图片/工具返回使完整请求超限时，在发送前触发确定的裁剪/容量拒绝；不能只检查 L3。 | 部分验证（单测）：请求计数按面归因（system 提示 / 工具定义 / 上下文信封 / 期望输出 schema / 工具历史），逐轮累计估算并累加 provider 上报用量，超限在**发送前**以 `TOKEN_BUDGET_EXCEEDED` 拦截；诊断经 `AgentRunResult.tokenEstimation` 暴露估算器、分面计数、实际用量与误差。**`generic_llm` 只发送字符串消息，多模态不适用于本适配器；长 schema 与多模态矩阵仍未验证。** |
| P2A-AC6 | P2A-T5、P2A-T6 | 并发专家不可各自花完整剩余额度；重启/重试不重置累计预算；预算耗尽进入主 Agent 可解释的等待状态。 | 待验证：T5 未开始，无累计预算总账与并发预留/结算实现。 |
| P2A-AC7 | P2A-T3、P2A-T4、P2A-T6 | 最小必要证据仍超容量时不发送残缺请求，不宣称完成；相同补读要求去重，有限重试后给出原因。 | 部分验证（单测）：超限返回可理解的容量阻塞而非静默截断（不是发送后截断）；补读去重由既有 supplemental-context-dedupe 覆盖。**拆分任务与旧工具输出引用化未验证。** |

## 2. 现有验证入口

以下命令从仓库根目录实际执行（2026-09-17）。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts apps/server/src/modules/message-routing/message-ingress.service.spec.ts apps/server/src/modules/intent-recognition/deterministic-command-guard.service.spec.ts
node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test apps/server/src/modules/runtimes/generic-llm-tool-loop-budget.spec.ts
npm run typecheck
```

相关既有测试：

- [deterministic-command-guard.service.spec.ts](../../apps/server/src/modules/intent-recognition/deterministic-command-guard.service.spec.ts)
- [command-application.service.spec.ts](../../apps/server/src/modules/message-routing/command-application.service.spec.ts)

**注意**：以 `tsx --test` 批量运行 spec 时必须显式传 `--tsconfig apps/server/tsconfig.json`。省略会因 `experimentalDecorators` 未启用而报 `Parameter decorators only work when experimental decorators are enabled`，把带 NestJS 装饰器的文件整片误判为文件级失败。官方 `run-unit-tests.mjs` 之所以不受影响，是因为它把 `cwd` 设在 `apps/server`。

## 3. 必须补充的测试

- [x] 最终 adapter 请求及每轮工具循环 Token 守卫测试——已补 `runtimes/generic-llm-tool-loop-budget.spec.ts`（3/3，含“超预算轮在发送前被拦截、未被截断”断言）与 `runtimes/generic-llm-token-estimation.spec.ts`（5/5，覆盖分面归因、跨轮累计用量、material 误差、零用量不伪造误差、容量阻塞仍留诊断）。
- [ ] 独立 PostgreSQL 预算并发预留/结算测试（依赖 T5，待新增）。
- [x] 主 Agent 消息意图标注 fixture 回归——semantic-intent-router 的 golden dataset 用例经同一 `validate` 路径执行。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。（T5 未开始）
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。（本阶段新增部分待 T6 验证）
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。（T3-2 已固化 L0 信任边界与越权用例，其余待 T6）
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。（本阶段尚无双端 E2E）
- [x] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。本次证据只记录命令、用例名与计数。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

**本次复核发现的未闭合风险**：`apps/server/src/common/path-safety.ts` 的 `assertWithinRootRealpath` 在符号链接 `realpath` 抛 `ENOENT` 时会走“尚未创建”回退分支，退化为纯字面路径比较并**放行**越界符号链接。本机实测：`symlink()` 返回成功但 `realpath()` 对该链接抛 `ENOENT`，导致 `workspace-symlink-guard` / `artifact-cutover-cleanup` 的 3 个越界符号链接用例失败（报 `Missing expected rejection`）。该文件最近提交为 `7908b3f`，**不在本次工作区改动范围内**，属既有缺陷；在无法创建符号链接的机器上测试会走 skip 分支而“通过”，因此长期未被发现。详见第 5 节。

## 5. 证据记录

执行日期：2026-09-17。环境：Windows、Node 22.22.2（另用 Node 20.19.6 复跑符号链接用例，结果一致）；当前未提交工作树；未调用真实付费模型。

| 范围 | 命令/入口 | 结果 |
| --- | --- | --- |
| T1/T2 核心 | 第 2 节第 1 条（4 个 spec） | 33 / 33 通过，0 失败 |
| T3 核心 | context-v2 全部 14 个 spec + `orchestrator.service.spec.ts` | 139 / 139 通过，0 失败 |
| T4-3 核心 | 第 2 节第 2 条 | 3 / 3 通过，0 失败 |
| T4-1 核心 | `runtimes/generic-llm-token-estimation.spec.ts`（5 例） | 5 / 5 通过，0 失败 |
| runtimes + common | 57 个 spec | 434 / 434 通过，0 失败 |
| Server 全量 | 194 个 spec（`tsx --test --test-force-exit --tsconfig apps/server/tsconfig.json`） | 1360 项：1348 通过、9 跳过、3 失败 |
| 类型检查 | `npm run typecheck` | 退出码 0，全部 workspace 0 错误 |

未执行并因此**不作为通过依据**：`test:e2e:*` 全部 E2E、独立 PostgreSQL 并发脚本、`@project/web` / `@agent-cluster/shared` / `@agent-cluster/desktop` / `@agent-cluster/local-runtime-cli` 单测、`npm run build`、`npm run test:harness`、真实模型验证。

Server 全量的 3 项失败全部位于符号链接越界守卫（第 4 节），已确认与被改动的意图/T4 文件无关：`workspace-symlink-guard.spec.ts`、`workspace-symlink-guard.ts`、`path-safety.ts` 在工作区均未修改。9 项 skip 为平台/可选环境用例。

本阶段开工时曾存在 7 个 TypeScript 编译错误（`generic-llm-runtime.service.ts` 缺 `llmInputSafetyMarginRatio` 导入、catch 分支误用未定义的 `selectedModel`；`generic-llm-tool-loop-budget.spec.ts` 误用 `responses`、`details.round` 类型未收窄；`debug-guard.spec.ts` 构造参数类型不符）。**这些错误没有阻断 `npm run test`，因为 tsx 会剥离类型**，其中一个 `ReferenceError` 被兜成 `MODEL_ERROR`，掩盖了真实原因。已全部修复；`generic-llm-tool-loop-budget.spec.ts` 断言中的英文 `/Estimated input tokens/` 改为断言中文 `/输入预算不足/` 并加强为“消息必须引用触发拦截的估算值”，理由是 `tests/e2e/chinese-visible-copy-smoke.mjs` 明确禁止英文 “Token budget exceeded” 出现在用户可见文案。

阶段通过条件**尚未满足**：精确命令零语义调用、目标与 @ 保留、完整请求预算三项目前只有单测证据；**累计并发预算（AC6）尚无实现**。该结论只表示当前工作树的单测与类型检查状态，不代表完成或上线。
