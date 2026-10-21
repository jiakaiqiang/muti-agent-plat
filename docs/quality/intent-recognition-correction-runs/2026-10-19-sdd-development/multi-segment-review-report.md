# 多段意图完整澄清展示实施报告

日期：2026-10-20。Run ID：`SDD-2026-10-20-multi-segment-review`。本轮推进 IR04.4、IR10.4 和 IR12 的确定性验收；依据 Spec/Plan 中“首个版本识别全部 segment 并展示结构化澄清”的要求。整个专项尚未完成。

## 问题与实现

原编译器能保存多段提案并阻止部分执行，事件却只携带简略 goal/action/dependency，Web/Desktop 未展示这组理解。用户只能看见通用澄清提示，无法核对第二目标、禁止项和继承内容。

本轮增加 `intent-multi-segment-review-v1` 只读诊断合同，随原计划事件和 Outbox 同事务保存完整 understanding、session/epoch/source/routing/revision 绑定及服务器快照提供的引用名称。保留全部段、目标、请求效果、禁止作用域、依赖、纠错替换和原文引用；不创建可执行步骤或关系确认卡，不授予任何效果权限。

Web/Desktop 共用组件，逐项显示最多 8 段，不截断后执行剩余部分。未知/跨会话/过长/依赖环/执行标记不合法的展示合同不会显示为合法计划。所有模型文本使用 Vue 文本转义，不作为 HTML 执行。当前状态通过绑定身份的 GET 核对；旧 revision、错 epoch/source、查询失败和断连不能声称仍待澄清；状态变化后保留历史内容而不冒充最新结果。BLOCKED/REJECTED 明确显示未获执行许可。

组件提供核对状态和展开原文，不提供批准整组或逐段执行按钮。用户可通过原输入框说明范围、顺序和限制；旧多段消息不会因新消息、刷新或重放自动执行。自动 ordered_plan 保持未启用，复杂澄清的结构化提交仍未完整实现。

## 验证结果

| 范围 | 实际结果 | 证据 |
| --- | --- | --- |
| 工作区全量 | 3109 通过，0 失败，37 条件跳过 | multi-segment-review-workspace-tests.log |
| 分项 | CLI 102、Shared 283、Server 2145、Server 开发脚本 7、Web 521、开发监督脚本 37、Desktop 14 | 同上 |
| 最终 Web | 523/523，含新增组件 11 项 | multi-segment-review-web-final.log |
| 相关服务/合同 | 22/22；最终只读类型调整另有 Shared 1/1 | multi-segment-review-focused.log、multi-segment-review-shared-final.log |
| 真实 HTTP | MS01–MS06，6/6 | multi-segment-review-http.log/results.json |
| 实际浏览器 | Web/Desktop 组件共 11/11，严格 script-src self CSP | multi-segment-review-browser.log |
| 类型与构建 | 全工作区 typecheck/build，最终 Web/Desktop build exit 0 | 对应 typecheck-final/build 日志 |
| 工程检查 | Harness 和 diff 检查 exit 0 | multi-segment-review-harness.log、multi-segment-review-diff-check.log |

全量中的 37 项为 32 PostgreSQL 和 5 Docker 条件项；本轮未新增数据库或容器执行，不能沿用上一轮的 32/32 作为当前新增内容的 PostgreSQL 验证。全量之后修正了两个只读测试赋值并新增两条 blocked/rejected UI 状态测试；最终 Shared 1/1、Web 523、类型与构建覆盖增量，计数不重复累加。

## 具体题目与效果

HTTP 固定原文：“先解释登录失败的原因，再评审修改建议。不要修改源码。”确定性 provider 分别返回 2 段和边界 8 段，目的是测试完整传递而非判断该原文实际应有 8 段。

- MS01/MS03：2/8 段与源消息、epoch、版本完整绑定，事件 understanding 与原提案完全一致。
- MS02/MS04：无 WorkItem、Brief 或执行 step；事件与 Outbox 保存完整诊断。
- MS05：每条消息只调用一次分类；伪造单段关系确认不能选择执行任意子集。
- MS06：实际 Nest 进程重启后，诊断不变、模型不重调、不创建部分步骤。

浏览器使用隔离 GET 夹具挂载真实 Web/Desktop 时间线，并设置 Desktop 同等的 script-src self 限制。两端分别检查 8 段完整显示、模型脚本文本不执行、Enter 展开原文、390px 无横向溢出、仅 GET、状态事件后保留历史；额外检查无 CSP/JavaScript 错误。截图位于 `output/playwright/intent-multi-segment-web.png` 和 `intent-multi-segment-desktop.png`。这不是实际 Electron 进程或 SSE 网络故障演练。

## 修正与限制

初始 UI 9 条失败暴露 Vue Proxy 不能被 structuredClone 直接复制，初始日志保留。随后检查 Desktop CSP 发现后端 Ajv 的动态编译不适用于 renderer，因此使用 TypeBox 解释执行同一严格 schema，加上相同跨字段校验；无需 unsafe-eval 或放宽 CSP。最终浏览器证明该路径可用。初始构建失败来自测试夹具对 readonly 字段赋值，改为保留数组的受控更新后通过，失败日志保留。

没有新增自动多段执行、通用 Brief/源码/外部效果执行，也没有完成独立模型准确率和 500+ 人工双标评测。IR04.4 的真实 CLI 合同传递、IR10.4 的完整复杂澄清交互、全部 58 场景及发布门仍保持未完成。无提交、发布、部署或生产配置变更。
