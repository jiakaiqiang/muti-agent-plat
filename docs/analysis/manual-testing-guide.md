# 手动测试指南 - 系统架构师结构化输出修复

**修复版本**：commit 540108c
**测试日期**：2026-08-04
**测试目标**：验证系统架构师能稳定生成 task_brief，不再出现 5 次失败错误

---

## 前置条件

1. ✅ 代码已提交：commit 540108c
2. ✅ 类型检查通过
3. ✅ 构建成功
4. 环境要求：
   - Claude Code 已安装并配置
   - CLAUDE_CODE_ENABLED=true
   - 模型：Opus 4.8

---

## 测试步骤

### 步骤 1：启动服务

**终端 1 - 后端服务**：
```bash
npm run dev:server
```

等待输出：
```
[Nest] INFO [NestApplication] Nest application successfully started
Server listening on http://localhost:3000
```

**终端 2 - 前端服务**：
```bash
npm run dev:web
```

等待输出：
```
VITE ready in XXX ms
Local: http://localhost:5173/
```

### 步骤 2：创建测试会话

1. 打开浏览器访问：`http://localhost:5173`
2. 点击「新建会话」或「开始对话」
3. 如果需要，选择工作目录（可选）

### 步骤 3：触发架构分析场景

在输入框中输入以下任一测试用例：

#### 测试用例 1：基础架构分析
```
分析这个项目的架构
```

#### 测试用例 2：详细架构分析
```
帮我理解一下当前项目的整体架构、主要模块和核心执行链路
```

#### 测试用例 3：特定模块架构
```
分析一下 apps/server 模块的架构设计
```

### 步骤 4：观察执行过程

**关键观察点**：

1. **系统架构师状态**
   - [ ] 显示「系统架构师」正在工作
   - [ ] 显示「系统架构师 的模型调用仍在进行中」
   - [ ] **重点**：等待时间应 < 120 秒（远小于之前的 480 秒）

2. **brief_generation 阶段**
   - [ ] 阶段显示为「brief_generation」或「任务简报生成」
   - [ ] **重点**：不应出现「MODEL_ERROR」
   - [ ] **重点**：不应出现「Failed to provide valid structured output after 5 attempts」

3. **成功标志**
   - [ ] 显示「任务契约已生成」或类似消息
   - [ ] 出现任务简报卡片（Brief Card）
   - [ ] 显示建议的任务（suggestedTasks）
   - [ ] 任务状态为「等待用户确认」

### 步骤 5：验证输出质量

点击生成的任务简报，检查内容：

#### 必填字段验证
- [ ] **goal**：有明确的目标描述
- [ ] **scope**：列出了分析范围
- [ ] **outOfScope**：说明了不包含的内容
- [ ] **constraints**：列出了约束条件
- [ ] **acceptanceCriteria**：有验收标准
- [ ] **risks**：识别了风险
- [ ] **openQuestions**：列出了未决问题
- [ ] **suggestedTasks**：至少有 1 个任务

#### suggestedTasks 验证
对于第一个任务，检查：
- [ ] **title**：有标题（如「分析项目架构与主链路」）
- [ ] **description**：有详细描述
- [ ] **suggestedAgentKey**：为「architect」
- [ ] **routingMode**：为「coordinator_controlled」（注意下划线拼写）
- [ ] **requiresUserConfirmation**：为 boolean 值
- [ ] **acceptanceCriteria**：包含验收标准数组

---

## 预期结果

### ✅ 成功标准

1. **生成速度**：< 120 秒完成
2. **无错误**：不出现「Failed to provide valid structured output after 5 attempts」
3. **结构完整**：task_brief 包含所有必填字段
4. **内容合理**：
   - goal 描述了架构分析目标
   - suggestedTasks 包含架构分析任务
   - routingMode 拼写正确（coordinator_controlled）
   - acceptanceCriteria 包含架构相关的验收标准

### ❌ 失败标准

如果出现以下情况，说明修复未生效：

1. **超时**：等待 > 300 秒仍无响应
2. **错误消息**：
   - 「Claude Code exited with code 1」
   - 「Failed to provide valid structured output after 5 attempts」
   - 「MODEL_ERROR」
3. **Schema 验证失败**：
   - 「RUNTIME_OUTPUT_CONTRACT_VIOLATION」
   - 缺少必填字段
   - routingMode 拼写错误（如 camelCase 或连字符）

---

## 故障排查

### 如果仍然失败

#### 1. 检查环境变量
```bash
# 确认 Claude Code 已启用
echo $CLAUDE_CODE_ENABLED  # 应该是 true

# 确认模型
echo $ANTHROPIC_MODEL  # 应该是 opus-4-8 或类似
```

#### 2. 检查 Claude Code 版本
```bash
claude --version
```

#### 3. 查看详细日志

**后端日志**：
- 在启动 `npm run dev:server` 的终端查看
- 搜索关键词：`claude-code-runtime-adapter`、`task_brief`、`structured output`

**前端控制台**：
- 打开浏览器开发者工具（F12）
- 查看 Console 和 Network 标签页
- 搜索错误信息

#### 4. 检查修复是否生效

验证文件已更新：
```bash
git show HEAD:apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts | grep -A 5 "CRITICAL: You MUST return"
```

应该能看到新增的详细指令。

#### 5. 重新构建

如果服务是在修复前启动的：
```bash
# 停止服务（Ctrl+C）
npm run build
npm run dev:server  # 重新启动
```

---

## 测试记录模板

请在测试后填写：

**测试时间**：____________________

**测试用例**：
- [ ] 测试用例 1：分析这个项目的架构
- [ ] 测试用例 2：详细架构分析
- [ ] 测试用例 3：特定模块架构

**结果**：
- [ ] ✅ 成功 - 无错误，生成完整 task_brief
- [ ] ⚠️ 部分成功 - 生成但有问题：_______________
- [ ] ❌ 失败 - 错误信息：_______________

**生成时间**：_______ 秒

**输出质量**：
- goal 质量：[ ] 好 [ ] 中 [ ] 差
- suggestedTasks 质量：[ ] 好 [ ] 中 [ ] 差
- routingMode 拼写：[ ] 正确 [ ] 错误

**备注**：
_______________________________________________
_______________________________________________

---

## 回归测试

### 验证不影响其他场景

除了架构分析，还应测试其他使用 task_brief 的场景：

1. **普通需求拆解**：
   ```
   帮我实现一个用户登录功能
   ```

2. **前端开发需求**：
   ```
   给我做一个响应式的导航栏
   ```

3. **后端 API 需求**：
   ```
   实现一个 REST API 来管理用户
   ```

确认这些场景也能正常生成 task_brief。

---

## 联系人

测试过程中如有问题：
- 参考诊断报告：`docs/analysis/structured-output-failure-diagnosis-2026-08.md`
- 参考修复总结：`docs/analysis/structured-output-failure-fix-summary.md`
- 提交代码：commit 540108c

---

**测试检查清单**

- [ ] 服务已启动
- [ ] 测试用例已执行
- [ ] 无「5 attempts」错误
- [ ] task_brief 生成成功
- [ ] 所有必填字段完整
- [ ] routingMode 拼写正确
- [ ] 生成时间 < 120 秒
- [ ] 测试结果已记录
