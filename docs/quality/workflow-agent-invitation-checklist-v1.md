# 工作流缺少 Agent 时的证据化邀请与拒绝引导 - Checklist v1

> 状态：核心代码及 Web/桌面生产 renderer 双客户端验收完成；原生 Electron 进程验收受环境阻塞。下表只把已有独立证据标绿，不把 mock、构建或 Chromium renderer 结果当作 Electron 通过证据。

## 验收矩阵

| AC | 任务 | 验证场景和必须观察到的结果 | 当前状态 |
| --- | --- | --- | --- |
| WAI-AC1 | T1/T2 | 发布图含开发/机器人质量审核 Agent；仅未参与者可邀请；disabled/unknown 和混合缺口不能半启动；已参与者不重复邀请 | 代码+单测+HTTP E2E 通过 |
| WAI-AC2 | T1/T3/T4 | 两端展示 Agent 名称、每个关联节点、类型、阶段/审核依据、缺失影响、流程名/版本；空字段如实标明；无虚构“需求必须由此 Agent 完成” | 代码+Web/桌面组件+客户端呈现通过 |
| WAI-AC3 | T1/T2/T3/T4/T5 | 批准触发真实后端接口，同一原选择在校验后最多创建一个 run；断线后继续可恢复，加入成功但启动失败不谎称“已启动” | 服务端定向、file/PostgreSQL 与专项双客户端 HTTP/SSE E2E 通过；原生 Electron 待环境补验 |
| WAI-AC4 | T2/T3/T4 | 拒绝不加人、不启动、不删节点；服务端回执后弹出结果对话框，列出被拒 Agent/无法执行节点与两个去向；桌面只读并可去 Web；新流程必须由用户重新选择 | HTTP E2E+双端组件通过 |
| WAI-AC5 | T1/T3/T4/T5 | Web/桌面同一待决卡与最终决定；刷新、SSE 重连、重复提交不重复造卡或启动；不反复弹出原选择框 | 专项双客户端同时在线竞争、冲突同步、重连补偿与刷新恢复通过；原生 Electron 待环境补验 |
| WAI-AC6 | T2/T4/T5 | 版本/hash/文档变化、下架、Agent 禁用、停止/删除均 fail closed；拒绝质量 Agent 不静默跳过审核节点 | 定向服务端安全边界及双客户端冲突收敛通过；原生 Electron 待环境补验 |
| WAI-AC7 | T2/T5/T6 | 无缺口流程照常启动，返工依图运行；批准仍写会话成员，后续讨论候选行为与现状一致 | 回归测试+全量 server/web/build 通过 |

## 测试层级

1. **合同与单测**：映射/节点投影、确认卡字段和状态；相同 Agent 多节点、未配置描述、混合可邀请/不可用、旧卡重放。
2. **后端集成**：同一原选择重复请求只出现一个待决决定；批准后仍须通过原流程/需求版本校验，拒绝无运行；file 与独立 PostgreSQL 的重启和并发一致。
3. **双端**：真实接口接线、卡片文案、拒绝导航、新流程重选、Web/桌面相同会话同时点击；桌面无写入型流程入口。
4. **回归**：需求文档确认、WorkflowRun 唯一启动、质量拒绝返工、停止/删除与会话群聊讨论范围。

## 必须保留的失败证据

- workflowVersion 或 definitionHash 改变、需求/文档确认过期：不能沿用旧卡启动。
- Agent 选择后禁用或找不到：不能邀请，不能只添加其他缺口 Agent 后半启动。
- 客户端乐观事件丢失/断线：以服务端决定为准；重复点击不会制造第二次邀请或执行。
- 用户拒绝流程里的质量 Agent：不能自动删除质量审核节点；需要明确改选或在 Web 设计并发布新流程。

## 验证入口与证据登记

实施后运行 Tasks 所列定向/全仓命令，并新增专项双端 E2E；记录日期、提交/工作树、环境、测试数据、命令、退出码、截图及失败原因。无 GUI 环境时不能将桌面渲染失败标绿；mock/stub 成功不能冒充真实模型验证。本文不授权模型调用、业务库迁移或发布。

最终退出条件：WAI-AC1～AC7 均有代码和独立验证证据，且批准/拒绝双端真实 HTTP 路径、恢复及工作流版本安全边界全部通过。文档创建不改变当前功能状态。

## 已执行证据（2026-09-20）

- `npm run typecheck`：通过。
- `npm run test --workspace @agent-cluster/server`：最终状态复跑退出码 0；专项会话定向测试 126/126 通过。
- `npm run test --workspace @agent-cluster/shared`：195/195 通过。
- `npm run test --workspace @project/web`：321/321 通过；专项确认卡/事件投影 22/22 通过。
- `npm run test:desktop`：13/13 通过；桌面生产构建通过。
- `npm run test:e2e:requirement-document-handoff`：通过，覆盖拒绝、明确重选、批准、重复批准单次启动。
- `npm run test:e2e:workflow-agent-invitation`：通过（退出码 0）；使用隔离 file persistence、真实后端 HTTP/SSE、Web 生产 bundle 与桌面生产 renderer bundle。覆盖同一卡片/节点证据、跨端相反决定竞争与 `409`、失败端权威同步、拒绝后服务端只发布一张新的 `select_workflow` 卡、Web 点击“选择其他已发布流程”实际打开选择器、明确重选唯一新映射卡、SSE 断线补偿、批准唯一启动、批准重放和刷新不复活旧卡。Runtime 使用延迟 mock，未调用真实模型。
- `npm run test:e2e:client-presentation`：Web/桌面通过。
- `npm run build`：全部 workspace 构建通过；仅有现存 bundle 体积警告。
- `node scripts/test-session-persistence-postgres.mjs`：一次性 PostgreSQL 数据库 16/16 通过，已自动删除。
- `npm run test:harness`：全部 Harness 阶段通过。
- 专项截图：`output/playwright/workflow-agent-invitation/web-pending.png`、`desktop-pending.png`、`web-resolved.png`、`desktop-resolved.png`。
- `npm run test:e2e:desktop-render`：阻塞；原测试复跑仍报 `Renderer process crashed` / `Target page, context or browser has been closed`。本机隔离的最小 Electron 应用在 Playwright/CDP 启动时也退出 `0xC0000005`，Chromium GPU 子进程曾退出 `-1073741515`；直接启动本应用的临时原生诊断则在页面代码加载前得到 `ERR_FAILED (-2) loading 'agent-cluster://app/desktop'`，协议处理器没有记录到资源异常。临时诊断代码已撤回，不能据此判定业务页面或邀请逻辑有缺陷，也不能视为原生桌面通过。沙箱外重跑的审批服务因不支持其配置模型返回 `404`，命令未实际执行；需在可用的 Electron/Windows 图形环境复验。
