# M4-12 · M4 全量回归 + 文档同步

> 状态：✅ 已完成（2026-07-10）  
> 结论：基础质量门、专项 e2e、legacy 回归和文档同步均已完成。

## 目标

跑 M1/M2/M3/M4 累计 e2e、更新功能清单、发布内部 changelog。

## 依赖

M4-11。

## 前置阅读

- 现有 `docs/analysis/feature-inventory-and-status-v1.md`

## 测试步骤

新建 `tests/e2e/session-resumption-smoke.mjs`：
1. 走完一个任务 → completed
2. 二次派发同 (agentId, taskId) → adapter 收到 options.resume（用 stub 断言）
3. `ENGINEERING_RUNTIME_STREAMING=all` 下跑通

新建 `tests/e2e/workdir-brief-smoke.mjs`：
- 断言临时 workdir 生成 CLAUDE.md/AGENTS.md、任务结束清理

新建 `tests/e2e/skill-injection-smoke.mjs`：
- 挂 skill → 断言 contextPack.systemRules 含 skill.content

## 验收命令

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
ENGINEERING_RUNTIME_STREAMING=all node --test tests/e2e/session-resumption-smoke.mjs
ENGINEERING_RUNTIME_STREAMING=all node --test tests/e2e/workdir-brief-smoke.mjs
node --test tests/e2e/skill-injection-smoke.mjs
```

## 验收目标

- [x] 上述全绿
- [x] `docs/analysis/feature-inventory-and-status-v1.md` R4/R5/R6 状态更新为已完成
- [x] 项目根 `CHANGELOG.md` 追加 M1–M4 概述条目

## 完成记录

> 完成日期：2026-07-10  
> 状态：✅ 已完成（受控环境验收）

- `npm run typecheck`、`npm run test`（325/325）、`npm run test:harness`、`npm run build` 全部通过。
- `session-resumption`、`workdir-brief`、`skill-injection` e2e 全部通过。
- 同轮完成 Codex/Claude streaming、Autopilot 和 legacy/off 回归。
- 真实 CLI 凭据、PostgreSQL apply、Redis scheduler 属于部署环境验收，不影响 M4 代码交付状态。

## 时间估算

15 分钟（若无遗留问题）。

## 提交信息

```
task(M4-12): M4 全量回归 + 文档同步
```

## 完成 M4 后

- R7 Autopilot 需先出独立专题设计（本清单不含）
- v0.3 清理（M5）也需要独立评审：删 deprecated 字段、删旧 execFile 路径、灰度开关默认 all
