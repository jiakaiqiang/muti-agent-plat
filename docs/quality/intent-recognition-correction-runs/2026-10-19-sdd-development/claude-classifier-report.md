# Claude 受限意图分类开发记录

Run ID：`SDD-2026-10-20-claude-classifier`。本轮完成 IR03/IR04.4/IR12 的一个 Runtime 切片，整个专项仍在实施中。

## 行为与边界

服务端 `claude_code` 现在支持 `routing` 准入下的 `intent_understanding@1.0` 和旧 `intent_routing_decision@1.0`。共享策略、候选选择、Worker 与适配器均检查准入。只接受空工具目录、零工作区能力和无写入；拒绝旧会话恢复、错误 phase、task 和未知版本。`local_bridge` 和 Codex 分类仍不开放，回答及业务执行权限没有扩大。

分类继续运行在独立 Server Runtime Worker。它不要求或绑定项目目录，由适配器创建临时空目录；不扫描源码、不写工作区 Brief/sidecar、不调用测试，也不返回 CLI 会话供恢复。结束或取消时清理临时目录。Worker 原有凭据隔离与模型连接解析保留，平台 modelId 不会误作供应商模型名。

固定启动参数关闭内置工具、MCP、技能、自定义配置和持久会话；只有一次 agent turn。CLI 自带重试关闭，格式修复留给持久化分类器。特意不使用 `--json-schema` 的 StructuredOutput 工具和内部修复循环，而是在提示中传完整 Schema，再由服务端版本化合同严格校验。非法输出只产生有界修复反馈。无法取得用量时明确记为 `unknown`，不记为已测量零消耗。

依据为本机 Claude Code **2.1.283** 帮助与实际请求观察；[官方 CLI 参数](https://code.claude.com/docs/en/cli-reference)说明工具、配置隔离和 turn 上限，[官方环境变量](https://code.claude.com/docs/en/env-vars)说明 API 重试及 watchdog 设置。旧版本不支持参数时失败关闭。Codex 的只读 sandbox 尚不足以证明完全无工具，故没有放开。

## 实际验证

`run-intent-claude-classifier-sdd.mjs` 启动本机原生 Claude CLI 和本地确定性 Anthropic 响应服务，使用临时配置、临时 File 数据与虚拟凭据；不读取、修改实际模型连接。

| 检查 | 实际结果 |
| --- | --- |
| CLI-valid | 新合同解析通过，一次请求，工具为空，原消息/来源保留 |
| CLI-invalid | 格式错误返回修复反馈，一次请求，无 CLI 内部补调 |
| CLI-auth | HTTP 401 失败，一次请求 |
| CLI-rate | HTTP 429 失败，一次请求，未由 CLI 隐式重试 |
| CLI-tool | 供应商伪造 Bash 调用未执行，一次请求后失败 |
| CLI-isolation | 配置的 SessionStart hook 未运行，私有 CLAUDE.md 标记未进入请求 |
| CLI-durable-repair | 实际 Nest→Runtime→Worker→CLI 两次调用，一次格式修复；同一持久化 operation/deadline，业务保持暂停且无 WorkItem |
| CLI-replay | 相同已完成分类重放不再调用模型 |

8 项集成检查通过。该测试是 Runtime/分类服务入口，不是 Sessions HTTP 入口，也不是模型语义准确率评测。响应由本地夹具提供，不把固定输出通过等同于真实模型准确。

相关单测包含参数隔离、Bridge/恢复拒绝、实际 Worker 进程、取消清理、严格 Schema、有界反馈和模型名映射。最终相关 Worker/分类/路由回归 50 项通过。

全仓回归在最终 Worker 集成修订前通过 **3120 项，0 失败，37 跳过**：CLI 102、Shared 284、Server 2153、Server 开发脚本 7、Web 523、开发监督器 37、Desktop 14。最终 Worker 修订后重新执行服务端回归：**2154 + 7 通过、0 失败、37 跳过**，全仓类型检查与最终服务端构建通过。37 跳过为 32 PostgreSQL 与 5 可选 Docker，本轮未重跑这些环境。各次源码范围见 manifest，不将较早全仓运行冒充最终源码全量验证。

## 失败与修复记录

初始类型检查暴露版本合同联合返回值未收窄，已修正。候选测试错误地模拟成硬拒绝工具，调整夹具为真实 phase 拒绝；初始构建另暴露 schemaVersion 字面量类型丢失。真实 Nest 集成最初因 Worker 强制项目目录而阻止分类，随后为严格分类配置加入无项目绑定入口，普通执行仍要求目录。集成夹具缺临时加密键和错误读取模型列表字段也已修正。初始失败日志保留，不覆盖历史评测。

## 尚未验收

- 完整 Codex/Claude Bridge 能力、真实云模型语义质量、完整 CLI 故障和版本矩阵。
- CLI 对某些 429 只输出通用失败，未暴露可还原的 Retry-After；不会编造延时，仍受上层总次数/截止时间限制。
- 供应商响应固定，尚无独立 500+ 双人标注集和三轮真实模型评测。
- 通用 Brief/源码修改/外部效果、复杂澄清、全部 58 场景、完整 PostgreSQL/客户端/SSE/崩溃矩阵与发布门。

没有提交、发布、生产数据库操作或修改个人模型配置。IR04.4 与全部阶段门保持未整体勾选。
