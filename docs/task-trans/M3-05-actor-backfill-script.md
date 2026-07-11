# M3-05 · actor-ref 回填脚本 幂等 TDD

## 目标

新建 `scripts/backfill-actor-ref.mjs`：遍历 JSONB collection（`collaboration_events`、`agent_tasks` 等），按 M3-04 相同规则补 `actor`；**幂等**（多跑不改结果）。

## 依赖

M3-04。

## 前置阅读

- `persistence.service.ts` 单表 JSONB 结构
- 现有 `scripts/` 下其他脚本风格

## 测试步骤（红）

新建 `scripts/backfill-actor-ref.spec.mjs`（node --test）：

1. 准备内存假 collection 含 3 类样本（已有 actor / 只有 fromAgentId / 只有 system 事件）
2. 跑脚本 → 断言 3 类样本正确补齐
3. 再跑一次 → 断言无变更（幂等）
4. 破坏样本（actor.id='wrong'）→ 跑脚本**不覆盖**（保留破坏，只补 null）

## 实现要点（绿）

- 脚本从 `PersistenceService` 或直连 pg 读全量事件
- 抽取 `deriveActor` 逻辑到公共函数供 M3-04 与本脚本共享
- dry-run 模式默认（`--apply` 才真写）
- 输出总数 / 已跳过 / 已补 / 失败

## 验收目标

- [ ] 4 用例绿
- [ ] 默认 dry-run
- [ ] `--apply` 有效
- [ ] 幂等测试连跑 3 次结果一致

## 时间估算

15 分钟。

## 提交信息

```
task(M3-05): actor-ref backfill 幂等脚本 TDD
```
