# 本地中转模型价格配置实施进度

> 更新时间：2026-09-20 12:10（Asia/Shanghai）  
> 当前状态：可选价格基础与本地回归已完成；真实计费、费用预算和账单核对已转入后续专项  
> 所属范围：阶段 6 P6-T5 的历史实施记录；后续范围见总计划第 21 节

## 1. 本次目标

为模型管理增加本地中转实际费率配置，使远程模型可以保存并展示：

- 输入价格，单位 `USD / 1M tokens`。
- 输出价格，单位 `USD / 1M tokens`。
- 可选价格版本。
- 后续可选缓存读写价格。

成本计算继续使用 Provider 返回的实际 usage。缺少实际 usage 或价格时，费用必须保持 unknown，不能按 `0` 处理，也不能自动套用官方供应商价格。

价格来源采用以下优先级：

1. 模型管理中保存的模型级价格。
2. 部署侧 `AGENT_CLUSTER_RUNTIME_PRICING_JSON` 精确 connection id 价格目录。
3. 两者都没有时保持 unknown。

Web 与桌面端的 `/models` 路由都复用 `apps/web/src/views/AdminRouteView.vue` 和 `RuntimeModelManager.vue`，所以模型价格表单只修改一处即可同时生效。

## 2. 已完成

### 2.1 共享合同

已修改 `packages/shared/src/contracts.ts`：

- `RuntimeModelCreateInput` 的远程模型分支增加输入价、输出价、缓存读写价和价格版本。
- `RuntimeModelUpdateInput` 增加相同字段，并预留 `null` 清空语义。
- 沿用现有 `RuntimeModelPricing`，币种固定为 `USD`。

### 2.2 后端模型配置

已修改 `apps/server/src/modules/runtimes/runtime-model-config.service.ts`：

- 持久化模型结构增加 `pricing`。
- 新增远程模型时解析并校验手工价格。
- 编辑远程模型时更新或保留价格。
- 输入价和输出价必须成对配置。
- 所有价格必须是有限的非负数字，允许明确配置为 `0`。
- 模型级持久化价格优先于部署环境价格目录。
- 模型连接和脱敏模型选项都会返回价格元数据。
- 价格变化不参与 connection id 生成，不改变连接身份。
- 未指定版本时由费率生成确定性 `manual-<hash>`；费率变化自动改变版本，手动复用旧版本修改费率会被拒绝。

### 2.3 Web/桌面共用界面

已修改：

- `apps/web/src/stores/runtimeModel.ts`
- `apps/web/src/components/RuntimeModelManager.vue`

当前已经具备：

- 添加远程模型时填写输入价格、输出价格和价格版本。
- 编辑远程模型时回显和修改价格。
- 前端拒绝只填写输入价或只填写输出价。
- 模型卡显示输入/输出费率。
- 未配置价格时显示“未配置，费用未知”。
- API Key 仍使用密码输入框，编辑时不回显已有 Key。
- 编辑已有价格时同时清空输入价和输出价再保存，可以删除模型级价格；API Key 留空仍表示保留原值。

### 2.4 已有阶段 6 基础能力

以下能力在本次模型级价格改造前已经存在，可被本功能复用：

- 部署侧版本化价格目录解析和精确 connection id 匹配。
- Generic LLM 对实际 usage 的费用估算。
- `priceVersion` 和 `costBasis='estimated'` 成本证据。
- 缺价格、缺 usage 时保持 unknown。
- 真实模型调用前的授权、调用次数和费用上限门禁。

## 3. 本次验收结果

### 3.1 后端测试：通过

`runtime-model-config.service.spec.ts` 定向测试 10/10，覆盖：

- 新增远程模型后价格能够持久化并重新加载。
- 编辑价格不会改变 connection id。
- 模型级价格覆盖环境价格目录。
- 未配置模型级价格时环境目录仍可作为兜底。
- 负数、`NaN`、无穷值和只填一项时拒绝保存。
- API 响应不泄漏 API Key；持久化仍使用现有加密路径。
- 将输入价和输出价同时设为 `null` 时可以清除模型级价格。

还覆盖修改费率时自动产生不同版本、显式复用旧版本时拒绝。

### 3.2 前端交互：通过

两个价格框同时清空会发送 `null` 并移除模型级价格；只清空一项时不能提交。数值输入兼容浏览器 `v-model` 产生的 number 值；TypeScript 可选字段不再显式赋 `undefined`。

### 3.3 前端测试：通过

`RuntimeModelManager.spec.ts` 定向测试 3/3，覆盖：

- 添加远程模型时提交输入/输出价格。
- 只填写一项时禁用提交。
- 编辑时正确回显已有价格。
- 未配置时显示“费用未知”。
- 清除价格操作提交正确的 `null` 合同。
- API Key 不回显。

桌面端复用同一组件；桌面构建与 `test:e2e:client-presentation` 通过。`test:e2e:runtime-model-switch` 在隔离 file backend 和 fake Provider 上通过模型费率到实际 usage 估算成本的 HTTP 链路，并修正冒烟入口继承业务 PostgreSQL 的问题。

### 3.4 文档同步：完成

已更新：

- `docs/contracts/runtime-contract-v0.1.md`：补充模型级价格输入、更新、清空及优先级合同。
- `docs/design/main-agent-collaboration-phase-6-plan-v1.md`：记录模型级价格复用现有持久集合。
- `docs/implementation/main-agent-collaboration-phase-6-tasks-v1.md`：记录模型管理价格配置证据。
- `docs/quality/main-agent-collaboration-phase-6-checklist-v1.md`：登记实际通过的本地验证。
- `docs/devops/local-development.md`：说明页面配置和环境目录的适用范围与优先级。

### 3.5 隔离 PostgreSQL 投影回归：通过

`runtimeModelConfig` 写入 `runtime_model_configs.configuration.sourceRecord`，读取时从同一 JSON 投影恢复，没有逐字段裁剪价格。新增 PostgreSQL 集成用例在一次性数据库中验证输入/输出及缓存费率和价格版本的 SQL 投影、服务重建、改价后的再次重建；`node scripts/test-session-persistence-postgres.mjs` 16/16 通过，测试库已删除。未读取或改写业务库。

## 4. 验证记录

2026-09-20 本地执行并通过：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
git diff --check
```

此外 `npm run test:e2e:runtime-model-switch`、`npm run test:e2e:phase-6-cost-report`、`npm run test:e2e:client-presentation` 均通过。完整构建有既存大 chunk 提示，不影响退出码。本次未发起真实模型调用、未启用新策略或发布。

同日补充验证：`node scripts/test-session-persistence-postgres.mjs --check` 确认一次性数据库门禁；实际执行 16/16 通过；`npm run typecheck`、`npm run test`、`npm run build` 均通过。阶段 6 崩溃恢复用例在 Windows 下曾因 `taskkill` 无法可靠终止测试 worker 而等待不返回，现改用直接终止并设置退出超时，定向 `npm run test:e2e:phase-6-crash-restart` 通过。

阶段 6 总入口本轮在 `desktop-render` 停止：受限执行环境拒绝 Electron 沙箱/GPU 子进程，renderer 随后崩溃；禁用 Chromium 沙箱的诊断运行正常，但该方式会削弱产品安全边界，因此没有写入产品或测试配置，也不记为通过。此前真实沙箱通过证据保留，本轮复验需在允许 Electron GUI 子进程的环境中执行。

## 5. 当前风险与边界

- 当前工作树包含阶段 3 至阶段 6 的其他未提交修改，后续不得回退或覆盖这些已有变更。
- 本次配置的是本地中转实际费率，不能用 DeepSeek、OpenAI 或其他官方公开价格代填。
- 模型级价格持久化使用现有 `runtimeModelConfig` 集合，不新增独立价格表。
- 真实模型验收仍需要独立授权、`synthetic_fixture_only` 数据范围、最大调用次数和最大费用上限；页面填写费率不等于授予真实模型调用权限。
- 阶段 6 整体仍有真实模型质量、成本和发布证据未完成，不能因本功能完成而把阶段 6 标记为完成。

## 6. 后续阶段 6 工作

2026-09-20 用户决定将美元计费、真实费率验证、费用预算和账单核对移入后续专项，不再作为当前阶段正常流程的退出条件。当前阶段只保留 Provider usage、缓存计数、调用数、TTFT 和总耗时的采集与 unknown 边界；未配置价格时不得阻断服务启动、会话执行、Agent 调用或策略准入。

阶段 6 其余真实模型质量、桌面复验和发布准入仍按原四件套推进；后续计费专项见[总计划第 21 节](../roadmap/main-agent-collaboration-roadmap-v1.md#21-后续专项runtime-计费与账单核对)。已经实现的价格配置保持可选，不代表计费功能已启用，也不要求用户现在提供真实费率。

2026-09-20 用户确认真实模型计量应读取中转站实际返回值。远程流式请求现显式请求终止 usage 帧；平台可读取输入、输出、总 token，以及中转实际返回的 OpenAI/Anthropic 兼容缓存读写字段，并自行测量 TTFT/总耗时。未返回字段保持 unknown。执行真实 Opus 中转抽样仍属于会产生外部费用的操作，必须另有调用授权；其美元计费和真实费率验收留待后续专项。
