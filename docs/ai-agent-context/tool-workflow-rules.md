# AI 工具工作流规则

本文档维护 Claude、Codex 等 AI 工程工具的长期工作规则。

入口文件只保留少量强约束：

- `AGENTS.md`
- `.claude/CLAUDE.md`

详细规则放在本目录，并通过条件加载使用。

## 入口文件职责

入口文件只应该包含：

- 先读本索引目录。
- 默认使用 Harness Engineering。
- 用户说只询问时不要编辑。
- 不确定就先查项目地图。
- 高风险操作先确认。

入口文件不应该包含：

- 完整 Harness 阶段细节。
- 完整项目地图。
- 详细模块说明。
- 长篇测试说明。
- 所有永久记忆。

## 条件加载职责

`docs/ai-agent-context/README.md` 负责告诉代理：

- 当前任务需要读哪些文档。
- 哪些上下文不需要读。
- 如何避免过度加载。

`project-map.md` 负责告诉代理：

- 项目有哪些主要区域。
- 需求关键词对应哪些代码和文档。
- 修改后可能要跑哪些验证。
- 永久记忆应该维护在哪里。

`harness-engineering-protocol.md` 负责告诉代理：

- 如何按 Harness Engineering 完成任务。
- 什么时候只分析不实现。
- 什么时候需要人工确认。
- 如何交付和沉淀记忆。

## 维护规则

- 新增长期规则时，优先放到 `docs/ai-agent-context/`。
- 只有最高优先级、必须每次都看的规则才放入口文件。
- 如果某条规则只适用于某个模块，放到项目地图或模块文档，不放入口文件。
- 如果某条规则属于 Harness Engineering 本身，放到 `docs/harness-engineering/`。
- 如果某条规则属于产品范围，放到产品或功能状态文档。
- 如果某条规则属于合同，放到 `docs/contracts/`。

## 面向不同工具的说明

### Codex

Codex 读取 `AGENTS.md` 作为仓库级工作入口。

Codex 应根据 `AGENTS.md` 跳转到本目录进行条件加载。

### Claude

Claude 读取 `.claude/CLAUDE.md` 作为仓库级工作入口。

Claude 应根据 `.claude/CLAUDE.md` 跳转到本目录进行条件加载。

### 其他工具

其他 AI 工程工具如果没有专属入口，也应优先读取：

```text
docs/ai-agent-context/README.md
```

再按条件加载项目地图和 Harness 协议。

