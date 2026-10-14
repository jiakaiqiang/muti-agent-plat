# 内置提示与模型回复中文化

## 需求和边界

- 系统内置的群聊进度、上下文补充、失败提示、任务说明和报告文案使用简体中文。
- 模型输出在提示词中明确要求简体中文，不在展示层翻译任意模型或用户原文。
- 代码、命令、文件路径、URL、JSON 字段名、枚举、错误码保持不变。
- 原始诊断日志和展开的错误详情保留原文，便于排障。
- 不批量改写历史事件；仅为已知旧版内置提示模板提供展示兼容。

## 实现路径

- `packages/shared/src/user-facing-language.ts`：共用语言规则、阶段名称、已知历史模板和系统错误中文解释。
- `runtime-contracts/structured-output-instructions.ts`：所有结构化输出种类共用中文要求。
- 通用模型工具循环、本地 CLI 的旧版与精简提交、Codex/Claude 普通与 sidecar 提交均包含中文要求。
- 编排、运行时、流式事件、上下文补充、能力授权、模拟结果、读取代码和测试报告在生成处中文化。
- API 异常过滤器返回中文 `message`，保留 `code/details` 和服务端原始日志；前端兼容旧版英文错误。
- Web 与桌面端时间线、协作日志、计划和任务板使用同一已知模板展示规则。
- 断网和会话不存在的流程判断使用稳定错误码，避免翻译破坏错误恢复逻辑。其他资源的 404 不视为会话丢失。

## 回归入口

- `packages/shared/src/user-facing-language.spec.ts`：全部输出种类、历史模板、错误码、不改写普通文本。
- `packages/local-runtime-cli/src/adapters/prompt.spec.ts`：Codex/Claude 与两种提交格式。
- 三种模型适配器测试：本地、远程、工具循环与 sidecar 中文要求。
- `apps/web/src/components/ChineseNoticePresentation.spec.ts`：Web/桌面展示截图中的历史提示，不变更原事件。
- `apps/web/src/api/client.spec.ts`：JSON/Markdown 网络错误、取消、错误码与详情、会话缺失识别。
- 会话删除和停止状态测试：确认中文化不改变恢复、停止和清理行为。
- `npm run test:e2e:chinese-copy`：扫描已知英文内置模板回归。
- `npm run typecheck`、共享/CLI 全量测试、相关后端测试和 Web 全量测试。

## 生效与人工验证

前端刷新、后端和本地 Runtime 使用新构建后生效；正在进行的模型请求仍使用提交时的旧提示词。

1. 触发源码证据不足：群聊正文、上下文卡片原因和下一步指令应为中文，`evidence-empty` 与路径不变。
2. 触发 GitHub OAuth 未配置或模型 HTTP 401：应显示中文原因，详情仍可排障。
3. 使用通用模型、Codex、Claude Code 各完成一轮讨论/执行：新回复、标题、摘要、风险和后续建议应为中文。
4. 重试、上下文补充、本机断开、取消和删除会话：中文提示不应改变行为。
5. 用户输入英文、代码或外文引用：不得被展示层自动翻译。

提示词验证不等于真实模型遵从性验证；本次未对真实付费 Provider 发起请求。历史模型回复不自动翻译。

## 本次验证记录（2026-09-29）

- Web 全量测试：406 项通过，包含 Web/桌面中文提示展示。
- 本地 CLI 全量测试：96 项通过。
- 编排和运行时定向测试最终复跑：295 项全部通过；本地授权/通用模型定向测试 43 项通过。
- 会话、工作流、上下文路由、模拟运行时与本地授权联合测试：207 项通过。
- 中文文案扫描通过；共享语言与流式事件定向测试 6 项通过。
- 共享全量测试最新结果：262/263 项通过；`runtime-observation.spec.ts` 的 `submission_accepted` 断言失败。该测试及其 `runtime-observation.ts` 实现为当前工作区其他未提交文件，本次没有修改，不据此宣称全量绿色。
- 类型检查与 shared/server/local-runtime-cli/Web 构建通过。真实模型遵从性仍需按人工规则验证。

## 重启结果

用户已明确授权验证后重启。前端 8089 返回 HTTP 200，后端 8099 健康检查为 `ok`，新进程 55336，`runtimeBuildStale=false`。

本地 Runtime 原进程已停止，但新进程启动失败：已有 `github-session:…` 工作区 ID 在 `state.ts` 的 `workspaceIndexFilePath()` 校验中被拒绝，`loadState()` 因此退出。本次未删除授权或工作区绑定，也未扩大范围修改该状态合同；本地 Runtime 新规则的生效仍被此启动问题阻塞。
