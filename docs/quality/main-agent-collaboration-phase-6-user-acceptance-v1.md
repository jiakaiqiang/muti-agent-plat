# 阶段 6 用户验收记录 v1

> 用途：提供给产品/业务用户的可执行验收项。
> 
> 当前状态：待用户验证。本文不代表阶段 6 已通过，也不替代自动化测试证据。

## 使用方式

1. 在仓库根目录 `D:\demo\muti-agent\muti-agent-plat` 执行命令。
2. 手工场景使用当前同一份本地 Web/桌面开发环境。
3. 每项只记录“通过”“失败”或“未执行”，并附一句现象；不要把未执行记为通过。
4. 本地自动化命令使用 mock/隔离数据，不会连接业务 PostgreSQL 或真实付费模型。

## A. 本地自动化复核

| 编号 | 命令 | 通过标准 | 结果 |
| --- | --- | --- | --- |
| A1 | `npm run test:harness:main-agent-phase6` | 退出码 0；追踪矩阵能读取 9 阶段、61 AC、54 Task | 待验证 |
| A2 | `npm run phase-6:traceability` | 输出中不存在 `pending`、`not-executed`、`failed`、`missing`；允许保留已声明的 `partial`/`deferred` | 待验证 |
| A3 | `npm run test:e2e:phase-6-long-session` | 退出码 0；100 WorkItem/1000 messages，受控输入不超过基线 1.2 倍 | 待验证 |
| A4 | `npm run test:e2e:phase-6-backend-parity` | 退出码 0；file 与隔离 PostgreSQL 对等，rollback/reapply 通过；临时库自动清理 | 待验证 |
| A5 | `npm run test:e2e:phase-6-crash-restart` | 退出码 0；崩溃后可 reclaim，且只发布一次 | 待验证 |
| A6 | `npm run test:e2e:phase-6-cost-report` | 退出码 0；usage、缓存、TTFT/总耗时可见，报告不含凭据和完整消息正文 | 待验证 |
| A7 | `npm run test:e2e:phase-6-safety-gates` | 退出码 0；未知停止、未确认版本、高风险能力和迟到结果均 fail-closed | 待验证 |
| A8 | `npm run test:e2e:phase-6-dual-client` | 退出码 0；Web/Desktop 共享业务状态但保留各自样式 | 待验证 |
| A9 | `npm run typecheck` | 退出码 0 | 待验证 |
| A10 | `npm run build` | 退出码 0；Web、Desktop、Server、Shared 均完成构建 | 待验证 |

说明：`npm run test:e2e:desktop-render` 如果在当前机器因 Electron sandbox/GPU 子进程被系统阻止而失败，不要使用 `--no-sandbox` 作为正式通过证据；请记录失败日志，等待允许安全沙箱后重跑。

## B. Web/桌面手工验收

先执行 `npm run dev`，确认 Web 和桌面窗口都打开；Web 默认地址为 `http://127.0.0.1:8089`。每个场景至少保留一张截图或录屏。

| 编号 | 场景 | 通过标准 | 结果 |
| --- | --- | --- | --- |
| B1 | 创建两个会话，使用同一个 Agent；在会话 A 执行任务 | A 显示执行中，B 可以独立打开；B 不显示 A 的运行句柄、消息或状态 | 待验证 |
| B2 | 在 A 点击停止，再刷新 Web 和桌面 | A 停止状态一致且不继续产生流；B 仍可继续使用；刷新后状态不回退 | 待验证 |
| B3 | 删除 A，再恢复 A | A 先进入可恢复隐藏/删除状态，迟到回调只保留审计；恢复后不会自动重放模型调用 | 待验证 |
| B4 | 群聊中 @ 一个指定 Agent 补充信息 | 只产生有界定向协作，最终由主 Agent 汇总；不会重跑全部 Agent | 待验证 |
| B5 | 工作流执行中发送“现在做到哪里了” | 只返回当前状态，不取消执行、不重新规划、不额外触发多轮模型调用 | 待验证 |
| B6 | 工作流执行中发送范围变更，例如“顺便增加导出功能” | 出现影响分析/确认卡；用户未选择前，当前需求契约和运行范围不改变 | 待验证 |
| B7 | 对同一变更卡在 Web 和桌面各点击一次 | 只记录一次选择；不会重复暂停、重复生成文档或重复启动流程 | 待验证 |
| B8 | 当前运行结束后有排队的新需求 | 出现下一需求提示，但不会跳过需求文档确认和流程选择自动执行 | 待验证 |
| B9 | Web 与桌面同时打开同一会话 | 两端业务状态最终一致；Web 样式不变，桌面保持独立 Codex 风格布局 | 待验证 |
| B10 | 查看 usage/运行信息 | 能看到输入/输出 token、缓存读写、调用数、TTFT/总耗时；中转未返回的字段显示 `unknown`，不阻断任务 | 待验证 |

## C. 真实模型抽样（可选，需单独授权）

此部分不会自动执行。只有在用户明确确认模型、最大调用次数、仅使用合成数据并允许产生中转调用后，才执行：

```powershell
npm run phase-6:live-model-preflight
npm run phase-6:live-model-evaluation
```

通过标准：

- 使用固定合成数据，不上传真实业务内容。
- 调用次数不超过你批准的上限。
- 记录真实输入/输出、缓存字段、TTFT、总耗时和失败原因。
- 真实模型质量结果单独记录，不能用 fake Provider 结果替代。
- 未配置价格时费用保持 `unknown`，不把本次验证变成计费验收。

## D. 当前明确不要求用户验证的项目

- 美元计费、`priceVersion`、费用预算、账单核对：已移入后续计费专项。
- 多模态 Provider：已延期到后续专项。
- 正式策略启用、生产数据库迁移、正式发布：需要单独的发布授权，不在本次用户自测中执行。

## 回报格式

请按以下格式回复：

```text
A1 通过
A2 通过
B1 通过：两个会话状态隔离
B2 失败：桌面端刷新后仍显示执行中
C 未执行
```

收到结果后，维护者才会：

1. 将有证据的项目写入阶段 6 Checklist；
2. 更新追踪矩阵中的 `partial/passed`；
3. 重新运行阶段 6 release preflight；
4. 只有所有必需 AC、有授权记录且发布边界满足时，才把阶段标记为完成。
