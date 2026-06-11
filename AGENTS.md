# AGENTS.md

本文档是 Codex 和其他 AI 工程代理进入本仓库时的轻量入口。

## 必须先做

- 默认使用 Harness Engineering 完成用户任务。
- 先判断用户是在询问、讨论、review、排查、验证，还是要求实现。
- 用户明确说“只询问”“先讨论”“不要写代码”“不需要改代码”时，不要编辑文件。
- 不确定需求落点时，先读取项目地图，不要直接实现。
- 高风险、破坏性、外部副作用、提交、发布、部署等操作必须先请求用户确认。

## 条件加载

开始任务后，按需读取：

```text
docs/ai-agent-context/README.md
docs/ai-agent-context/project-map.md
docs/ai-agent-context/harness-engineering-protocol.md
docs/ai-agent-context/tool-workflow-rules.md
```

加载规则：

- 普通实现类任务：读 `README.md`、`project-map.md`、`harness-engineering-protocol.md`。
- 只讨论工具工作流：读 `tool-workflow-rules.md` 和 `harness-engineering-protocol.md`。
- 只询问项目情况：读 `project-map.md` 和相关项目文档，不编辑文件。
- 涉及具体模块：只读取项目地图指向的相关代码、合同、测试和文档。

## 永久记忆位置

不要把所有长期规则堆到本文件。

- AI 工具工作方式：`docs/ai-agent-context/`
- Harness Engineering 规程：`docs/harness-engineering/`
- 产品范围：`docs/product/agent-cluster-prd-v1.md`
- 系统设计：`docs/design/agent-cluster-system-design-v1.md`
- 功能状态：`docs/analysis/feature-inventory-and-status-v1.md`
- 合同：`docs/contracts/`
- 质量验收：`docs/quality/`
- 运维开发：`docs/devops/`

## 验证

根据任务选择最小有效验证集合：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
```

只改文档时可以不跑完整测试，但最终回复必须说明。

