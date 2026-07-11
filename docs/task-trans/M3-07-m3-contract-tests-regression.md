# M3-07 · M3 合同测试全量 + e2e 回归

> 状态：✅ 已完成（2026-07-10）  
> 结论：ActorRef 双写、前端兼容和 file/PostgreSQL collection 回填专项测试通过；真实 PostgreSQL apply 待部署环境验收。

## 目标

M3 收尾：跑合同测试、事件相关 e2e、跑一次 backfill dry-run 验证真实数据无异常。

## 依赖

M3-06。

## 前置阅读

- `packages/shared/src/runtime-adapter-contract.test.ts` 现有合同测试
- e2e 事件相关：`memory-confirm-smoke`、`agent-create-smoke`、`multi-agent-discussion-smoke`

## 测试步骤

1. `npm run test`
2. `npm run test:harness`
3. `npm run build`
4. `node scripts/backfill-actor-ref.mjs`（dry-run 默认）→ 断言"待补 X 条 / 已补 0"
5. 跑一次 e2e：`node --test tests/e2e/multi-agent-discussion-smoke.mjs`（M1/M2 灰度 off）+ `ENGINEERING_RUNTIME_STREAMING=all` 再跑一遍

## 验收目标

- [ ] 全部命令绿
- [ ] backfill dry-run 报告合理（数字与本地事件数匹配）
- [ ] `docs/analysis/feature-inventory-and-status-v1.md` R3 状态更新
- [ ] `docs/contracts/event-contract-v0.1.md` v0.2 变更日志加日期

## 时间估算

15 分钟（若有失败回上一任务补）。

## 提交信息

```
task(M3-07): M3 合同测试 + e2e 回归
```
