# 跨会话切换稳定性与性能 Plan v1

日期：2026-09-29。状态：分层实施中；主要导航、业务回调隔离及窗口渲染已落地，完整验收未完成。阅读锚点复测仍偏移约 26px，按 Harness 连续返工规则暂停进一步实现，等待用户确认继续。

入口：[Spec](../product/session-navigation-performance-spec-v1.md) | [Task](../implementation/session-navigation-performance-tasks-v1.md) | [Checklist](../quality/session-navigation-performance-checklist-v1.md)。

## 1. 方案决策

选择“稳定工作台实例 + 导航轮次所有权 + 独立业务操作生命周期 + 有界展示”。

不选择：仅在旧 `router.push()` 前加一次条件（覆盖不了 Store/业务回调）；禁止连续点击（改变交互且隐藏竞态）；无限缓存所有会话组件（累积 DOM/监听器）；只截取事件尾部（破坏状态派生）。

现有事实来源仍是服务端会话/事件。新增状态仅是前端导航、缓存和展示状态，不引入第二套业务任务状态机。

## 2. Architecture Constraints

### allowedPaths

- `apps/web/src/components/{AppShell,SessionWorkspace,ChatTimeline,ChatScrollArea,UserInputBox,ConfirmationCard}.vue` 及对应测试。
- `apps/web/src/stores/{session,event,workspaceUi,workflow,runtimeModel,agent}.ts` 的相关读取、缓存及回调；其他实际调用者需以调用清单为依据。
- `apps/web/src/composables/useWorkspaceSync.ts`；拟新增 `useSessionSwitch.ts`、`useVirtualChatTimeline.ts` 和客户端内部类型/测试。
- `apps/web/src/api/client.ts` 仅在现有 `RequestInit.signal` 透传不足时最小补齐，不重写通用错误策略。
- `apps/desktop/renderer/components/{SessionWorkspace,ChatTimeline}.vue` 及共享接口调用点；`stores/taskWorkspace.ts` 的按需读取。
- `tests/e2e/` 中专项测试、隔离匿名 fixture；测试命令所需的 `package.json` 最小修改。
- 本四件套、文档入口；实施后同步 `docs/contracts/ui-state-contract-v0.1.md` 的 UI 语义。

### forbiddenPaths / forbidden_change_scope

- Server 编排、Runtime、队列、数据库迁移及 local-runtime-cli 执行业务代码。
- 凭据、系统配置、真实持久化数据、历史任务、服务启动脚本与依赖大版本升级。
- 用户不相关的未提交变更。禁止以 `reset --hard` 或整文件覆盖方式回退。

如验证发现需扩展 Server 合同或持久化格式，记录缺口并请求扩大范围，不偷偷并入本专项。

## 3. 组件与职责图

```text
侧栏/新建完成/前进后退 → Router（用户选择）
                               ↓
                      useSessionSwitch（唯一激活者）
                     ↙         ↓          ↘
              session cache  event连接    阅读/草稿
                     ↘         ↓          ↙
                  当前会话的可见窗口与状态

发送/确认/上传/修订 → 原会话业务操作 → 原会话缓存
                                      ↓ 仅当前会话仍匹配时
                                  展示刷新（不导航）
```

`SessionWorkspace` 负责组合，不继续承载另一套并行导航流程。虚拟列表只管理区间/尺寸，业务卡片仍负责原有内容。Web 与桌面保留各自外观，共享导航所有权和数据语义。

## 4. 客户端内部合同（拟定）

```ts
type SessionSwitchContext = {
  sessionId: string
  epoch: number
  signal: AbortSignal
  isCurrent: () => boolean
}

type SessionNavigationState = {
  targetSessionId?: string
  displayedSessionId?: string
  epoch: number
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
}

// 读取不选择；缓存刷新不导航；只有协调器可以激活。
fetchSessionDetail(id, { signal }): Promise<SessionDetail>
refreshSessionCache(id, options): Promise<SessionDetail>
activateSession(detail, context): void
```

以上是设计接口，不是已存在的导出。保留必要适配层逐步迁移调用者，最终清除业务回调隐式激活路径。按轮次和资源区分 `switching`、列表加载、后台刷新，不能继续用一个 loading 布尔值相互覆盖。

同会话并发读取除导航 epoch 外，还要有每资源请求代次/服务端版本防回退。无可靠服务端版本时仅接受最新发起的读取，不能把墙钟相等推断为数据相同。

## 5. 唯一导航与初始化

1. Web 会话路由使用稳定 key；其他管理路由维持原来的隔离。桌面已有稳定 key，不重复改造。
2. 侧栏只导航；路由 `sessionId` 的监听统一启动切换。仅 query 视图变化不重载同一会话。
3. 应用 bootstrap 合并在途初始化，保留版本兼容检查。首次无 ID 时选取有效会话并 replace 一次，禁止产生双加载循环。
4. 切换开始先捕获并保存旧会话草稿/锚点，再递增 epoch，取消旧读取并按所有权释放旧展示连接。
5. 立即高亮目标；无可用缓存时隐藏旧会话内容并显示目标加载态，禁止在目标未就绪时提交业务操作。缓存可先读展示，执行按钮仍受最新控制状态/现有安全屏障约束。
6. 获取目标数据；每次 await 返回及每次 Store 提交前验证轮次。过期成功、失败、finally 不得修改当前页面。
7. 激活目标后按原有连接恢复协议执行事件缓冲与补齐；下一帧确认目标消息/空态已展示后记录 ready。辅助文档无需阻塞 ready。
8. 404 展示目标不存在和返回列表入口；断网显示重试；不兼容遵守原升级门禁。取消本身不弹错误。故障不恢复任何后台任务。
9. 同 ID ready 状态重复点击不加载；error 状态的“重试”创建新 epoch。删除/归档当前目标由显式业务结果导航到有效目标，不由迟到读响应决定。

## 6. 群聊业务操作隔离

必须审计全部 `loadSession()`、`reconcileSessionEvents()` 和直接操作当前连接的调用者，不只侧栏入口。

- 发起时冻结 `sessionId`、确认/修订/附件 ID、正文和已有幂等标识。多步确认不能在 await 之后重新读取可变 `activeConfirmation` 来组装后续命令。
- 业务请求不使用导航 AbortController；busy/error/result 按会话与操作 ID 存储。
- 响应到达后写原会话缓存，禁止调用激活方法。若原会话仍是当前目标，再在有效轮次内安排刷新。
- 发送成功的 event 归原会话，可更新其列表摘要；不能为非当前会话调用会抢占连接的 `ensureConnected*`。
- 非当前会话需要核对结果时仅做目标明确的只读刷新，不改变当前 SSE。
- 未确认写入结果显示“结果待核对”，不把前端中断当作服务端取消；保留已有幂等能力，不添加自动业务重试。
- pending 业务操作持有自己的资源引用，导航不得释放其上传文件/预览对象。未提交草稿可恢复；已提交内容不能因迟到成功清空用户在原会话后来新写的草稿，需比较草稿版本。
- 停止、恢复、取消、写回等按钮仍使用现有服务端校验，仅显式点击可触发。

## 7. SSE 与周期同步所有权

- 展示连接的 owner 是 `(sessionId, epoch)`，而非仅 sessionId；释放操作先校验 owner，旧 finally 不得全局关闭新连接。
- 保留现有订阅、缓冲、cursor 补齐、事件 ID 去重与终态最终同步语义。连接不可用时仍保留只读降级恢复；不能把“已调用连接方法”当作历史已补齐。
- 每标签页最多一个当前展示连接。页面离开不影响服务端执行、Runtime 心跳或权限。
- `useWorkspaceSync` 读取当前导航 owner；切换期间不重入首轮加载，相同资源请求合并。焦点/网络恢复与定时刷新共同调度，不各自创建独立副本。
- 回调全程有 disposed/epoch 检查，区分取消与真实故障。返回旧会话时按其游标补齐，不能复用另一个会话的在途 Promise。
- inactive 会话的列表摘要沿用轻量列表刷新；不为每个列表条目创建工作台/SSE。

## 8. 草稿、弹窗与授权

- 复用 `workspaceUi.activateTask()`；Web 补齐调用点，桌面保留原行为。
- 每会话草稿包含文本、已选能力、Agent、附件引用/本地预览及草稿版本。File/Blob 只保留内存，不能 JSON 序列化进 sessionStorage；刷新后不可恢复的本地文件必须真实提示。
- 本次保证会话往返不丢状态，不新增敏感正文持久化范围。预览 URL 在删除附件、发送完成且无引用或真正释放草稿时撤销，不在普通切换时撤销。
- 未提交的弹窗关闭展示而不提交/撤销业务确认；已提交操作继续独立跟踪。
- 导航不能取消 workspace authorization。显式取消授权、关闭其授权流程或真正离开页面的清理沿用现有安全约束，并按授权 requestId 区分归属；不关闭 Runtime 本身。

## 9. 请求缓存与派生更新

- 去重记录持有资源身份、有效性及订阅者。一个导航订阅者取消只使其结果失效；仅最后一个订阅者离开才终止底层读取，不能误取消业务核对依赖的同一读请求。已 aborted 的在途记录立即移除，新 epoch 不复用它；共享数据到达后仍由各订阅者检查自己的 owner。
- Agent/能力目录：bootstrap 按需加载、同请求去重；相关管理写入后失效，显式刷新可重新读取。
- Runtime availability：从普通导航剥离，不绕过实际执行前的检查；启动/设置刷新按现有产品流程读取。不得为每次切换启动 CLI 版本探测。
- workflow 目录：由需要选择的当前待确认流程加载；历史已处理卡优先使用事件快照。管理发布/归档后失效，不能长期使用过期可选项。
- 文档缓存键至少含 sessionId/documentId/contentHash，沿用哈希校验与权限；可见或展开时读取，取消后可重试，不能永久留 loading。
- 空增量无状态替换；未变化消息保持对象引用。收到修正/删除事件时按已有内容/版本语义更新，不能仅凭 ID 相同忽略改变。
- 文档/差异重计算仅针对变化消息。大量首次派生按批调度并校验 epoch，不能在每帧复制全事件。
- 初始可重建详情缓存最多 3 个最近会话，正文/差异缓存序列化字节预算 16MiB；这些是客户端参数，不是 JS 堆上限。活动会话、草稿和 pending 写操作受保护，不为满足上限而丢业务状态。
- 如淘汰 inactive 的完整事件缓存，必须原子移除该会话 server/visible/derived 缓存、完整性标记及同步 cursor；下次重新完整读取。绝不留下 cursor 后只读增量，导致历史状态残缺。受保护数据单独报告，不能宣称内存无限增长已消失。
- 桌面 taskWorkspace 首先加载列表/摘要，所选执行再取详情；按 epoch 丢弃旧详情，不改运行中的任务。

## 10. 滚动与有界消息展示

### 滚动

移除无条件 `onUpdated(sync)`。使用一个 rAF 调度器合并尺寸/滚动通知，先读后写；ResizeObserver 仅登记脏标记。跟随底部时直接使用已知尺寸，不扫描 `[data-message-id]` 全集。

阅读状态为 `{sessionId, messageId, offset, following}`。保存频率最多约每 200ms 一次，切换/离开时最终保存；使用虚拟列表可见区首项定位。旧 epoch 的 rAF/observer/存储回调不应用到新会话。测量误差、图片加载、字体/窗口变化按锚点补偿，不反复重置到底部。

### 虚拟窗口

拟新增头部无业务的 `useVirtualChatTimeline`：稳定消息 ID、估算/实测高度、累计高度索引、可见区和上下各一屏缓冲、占位高度；滚动查找不做全历史 DOM 扫描。仅观察挂载项，尺寸按批更新，避免逐条触发布局。

Web/桌面保留各自消息模板，接入同一窗口模型。超长 diff/文档也分段或按需展开，不能只虚拟外层却让一条卡片产生无限 DOM。事件原始集合保持完整，业务状态与可见消息分离。

正在编辑/拥有焦点的消息在交互结束前固定保留；禁止通过 focus 自动跳会话。复制和既有引用定位从数据获取完整内容，再挂载目标区间，不依赖 DOM 全量存在。浏览器原生 Ctrl+F 只能搜索已挂载内容，不能冒称支持全历史；既有产品级搜索/复制入口若退化则阻断上线并在本范围内补足数据层定位。

虚拟化不是增删群聊能力，不改变消息顺序、确认卡状态、文件真实内容或模型上下文。单位测试无法证明布局性能，必须浏览器测量。

## 11. 测试、落地与回退

执行顺序和 10–15 分钟工作单元见 [Task](../implementation/session-navigation-performance-tasks-v1.md)。先写失败用例，再拆读取/激活，再处理导航和业务隔离，最后治理渲染与缓存。

测试组合：纯协调器/Store 延迟 Promise 单测；真实 Router 和组件行为测试；隔离服务/mock Runtime 的业务连续性测试；正式 Web 构建与实际 Electron renderer 的交互/性能测试。仅跑源码字符串检查或桌面主进程单测不算双端 UI 验收。

文档阶段只检查文档链接/追踪和 Harness 基础规约。开发阶段按 Checklist 执行 typecheck、Web/desktop 相关测试、构建及 E2E，不访问真实任务进行确认、上传或写回。

部署时分别记录 Web 构建和桌面构建；旧桌面安装包不会随本地源码自动更新。前端刷新也可能打断浏览器内未提交/上传操作，应先检查并保存，不以“后台 Runtime 不重启”推断所有浏览器操作无风险。

回退以本专项独立补丁或构建产物为单位，不回退用户其他工作。发布/回退需要另行授权；无需数据库回滚或 Runtime 重装。不默认新增生产切换开关；若某批未过门禁，不交付半套所有权机制。
