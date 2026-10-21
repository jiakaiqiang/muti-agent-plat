# 具有工作区只读授权的回答执行

日期：2026-10-19。对应 IR05/IR06/IR09 的部分实现，前置为[新合同纠错](semantic-correction-report.md)。完整 IRC-AC03、G2/G3 未通过。

## 实现和边界

新合同入口在用户显式选择且服务端验证 server_local 工作区时，保存独立的 workspace read grant；来源为首条原消息和经过验证的工作区绑定。绑定 hash 包含 epoch、用户、工作区、规范路径及选择/绑定时间。模型不能签发 grant，也不能从旧 requiresCodeChanges 获得它。无绑定、重新绑定或 grant.revokedAt 存在时，新的读取计划不能提交，旧回答不能继续执行。

编译器允许 answer + read_workspace，并继续检查资源、原文证据、禁止项和有效授权。response 通道仍无 Task、无写权限，不开放 business。纯回答没有工具；读取型回答只允许 read_file/search_code。补齐独立只读 Capability 定义，系统 Coordinator 持有它们；回答执行器按本次 scope 请求已授权工具，Profile 编译、Tool Authority 和 Runtime 交集仍可拒绝禁用或缺失能力。

Generic LLM 工具循环在每次调用前读取持久化计划/step、租约、有效版本、授权和 operation，拒绝停止/被替换的调用；读取路径来自有效 Session 绑定，不依赖旧 Orchestrator 的进程内路径缓存。补齐 search_code 的真实执行和审计。回答中的搜索强制按字面文本匹配，工具目录明确说明不执行正则；服务端忽略模型提供的 literal=false，避免嵌套量词阻塞事件循环。模型要求 write_file 等目录外工具时立即失败。现有路径规范化、realpath 根目录边界、敏感路径过滤和文本大小限制继续执行。

回答仍保留最多两次 Runtime invocation、120 秒绝对期限和一次格式修复；每个带工具 invocation 最多五轮 provider 请求、十二次工具调用。response 的适配器传输重试关闭，瞬时失败由上层消费原 attempt 预算。provider request、工具调用与 Runtime invocation 是不同计数，不将读取回答称为“最多两次 HTTP”。

无法解析执行器能力时保存有限的内部 failureDetail，用户仍看到回答未完成的状态。保存回复前再验有效版本；晚到内容不能绕过旧结果屏障发布。

## 验证

最终实际检查由 `tests/evaluation/run-intent-workspace-answer-sdd.mjs` 发起，使用真实 Sessions API、Generic LLM 文本工具协议、临时真实文件和确定性 localhost provider。最终证据为 `workspace-answer-http-verified.log`、`workspace-answer-http-results.json`，WR01–WR05 全部通过：

| 用例 | 实际观察 |
| --- | --- |
| WR01 | search_code 和 read_file 返回真实文件标记；最终回答含该标记。共 3 次 provider 请求：分类 1 次，工具回答 2 轮 |
| WR02 | 无 WorkItem/Brief，仅 routing/response operation，回答 invocation completed |
| WR03 | ../ 越界、.env 和指向外部目录的 junction 均返回拒绝；模型收到的工具结果不包含外部或敏感文件内容 |
| WR04 | 模型请求 write_file 后 CAPABILITY_BLOCKED，无成功回复，未进行额外重试 |
| WR05 | README.md 与敏感测试文件的 SHA-256 在运行前后完全相同 |

67 项初轮相关回归覆盖共享 scope、入口、回答、预算和 Runtime 选择。之后补齐了已提交计划的授权撤销检查、真正的默认只读工具定义、工具循环路径入口和失败诊断，最终范围以全仓验证记录和 manifest 为准。各范围重叠，不作为独立意图题目累加；fixture 输出不能证明模型准确率。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 全仓测试 | 2949 通过，0 失败，21 PostgreSQL 跳过 | workspace-answer-workspace-tests.log |
| 全仓类型检查 | 退出码 0 | workspace-answer-workspace-typecheck.log |
| 全仓构建 | 退出码 0；保留既有 chunk 大小提示 | workspace-answer-workspace-build.log |
| 最终字面搜索增量回归 | 85 通过 | workspace-answer-final-regression.log |
| 最终后端构建 | 退出码 0 | workspace-answer-final-server-build.log |
| Harness | 退出码 0 | workspace-answer-harness-final.log |

全仓测试分项：CLI 102、Shared 281、Server 2038、开发脚本 7、Web 470、开发监督器 37、Desktop 14。它覆盖本次主体；最后的字面搜索限制是在全仓运行之后加入，由最终 85 项、后端构建和 HTTP 重跑覆盖，没有把前次全仓日志称为最后增量后的重跑。Web 仍有组件 stub/嵌套提示；未因此修改无关界面。Harness 首次运行指出两个新 Capability 未写入既有工具治理参考表，补齐后通过。

## 失败和修复证据

- `workspace-answer-http.log`：共享包新增导出尚未构建；随后补齐 shared 构建，后端启动通过。
- `workspace-answer-http-built.log`：当前 GitHub 来源开关拒绝直接创建 server_local 会话。测试进程显式关闭该开关走已有兼容入口，没有修改真实配置。
- `workspace-answer-http-compat.log` / `workspace-answer-http-diagnostic.log`：旧默认 Capability 只有内部 Brief/Router，缺独立可请求的读工具；补齐只读定义和本次请求。
- `workspace-answer-http-tools.log`：旧工具循环入口仅检查 Orchestrator 路径缓存，导致新回答工具文本被当成最终 JSON；改为新版本回答从持久化绑定准入。最终 HTTP 检查通过。

## 未完成

该证据仅覆盖 server_local 兼容入口。当前 GitHub 默认新建流程、source-ready 后授予读取、本地 Bridge/CLI、权限撤销/重新授权 UI/API、实时工具调用期间撤销故障矩阵仍需完成。read_workspace 不包含测试、源码/产物写入或外部副作用；这些实际执行器、Brief 调度、特殊消息入口、完整双客户端/数据库矩阵、58 场景、独立 500+ 双人标注和发布门仍待推进。没有将整个 IR05/IR06 或 IRC-AC03 勾选完成，未提交、部署或修改用户模型连接。
