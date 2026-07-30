# 回滚到 2026-07-27 18:00 的可行性分析

**分析时间**: 2026-07-28
**触发需求**: 撤销 13 个文件在 2026-07-27 18:00 之后的所有修改，恢复成 18:00 之前的内容
**基线版本**: f204646 (2026-07-23 18:27, `main` = `origin/main`)
**结论**: **该还原点不存在，无法完整恢复。** 仅 3 个文档可精确还原，10 个代码文件不可重建。

## 执行摘要

1. 仓库在 2026-07-27 全天没有任何提交，18:00 这个时间点没有对应快照。
2. 六个常规恢复源（commit / stash / reflog / IDE 本地历史 / 卷影副本 / 回收站）全部为空或不含本项目。
3. 唯一残存线索是 Claude 会话日志中的增量 `Edit` 记录，反向回放 **成功 5 次、失败 36 次**（41 次尝试）。
4. 6 个 spec 文件由**外部工具**在 2026-07-28 08:48:43 批量写入，没有任何工具留下内容记录，完全不可重建。
5. 动手前已建立全量备份，当前工作区状态已保住；**尚未写入任何文件**。

## 一、13 个目标文件

以修改时间倒序，均未提交（相对 HEAD `f204646`）：

| 时间 | 文件 | git 状态 |
|---|---|---|
| 07-28 09:29 | `apps/server/src/modules/sessions/sessions.service.ts` | M |
| 07-28 09:29 | `apps/server/src/modules/sessions/sessions.controller.ts` | M |
| 07-28 09:29 | `apps/server/src/modules/orchestrator/orchestrator.service.ts` | M |
| 07-28 09:27 | `packages/shared/src/contracts.ts` | M |
| 07-28 08:48 | `apps/server/src/modules/sessions/workflow-session-flow.spec.ts` | M |
| 07-28 08:48 | `apps/server/src/modules/sessions/sessions.service.spec.ts` | M |
| 07-28 08:48 | `apps/server/src/modules/sessions/sessions-controller-v2-contract.spec.ts` | M |
| 07-28 08:48 | `apps/server/src/modules/orchestrator/runtime-stream-consumer.spec.ts` | M |
| 07-28 08:48 | `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts` | M |
| 07-28 08:48 | `apps/server/src/modules/orchestrator/context-router.service.spec.ts` | M |
| 07-27 19:10 | `docs/analysis/feature-inventory-and-status-v1.md` | M |
| 07-27 19:09 | `docs/roadmap/remediation-plan-v1.md` | M |
| 07-27 18:21 | `docs/design/capability-approval-resume-design.md` | ?? 新建 |

## 二、恢复源排查结果

| 恢复源 | 结果 |
|---|---|
| git 提交 | 最后一次是 **7/23 18:27** (`f204646`)，7/27 全天无提交 |
| git stash | 空 |
| git reflog | 7/23 之后无任何记录 |
| VS Code 本地历史 | 178 条条目，**属于本项目的 0 条** |
| JetBrains LocalHistory | 不存在 |
| Windows 卷影副本 | 无 |
| D 盘回收站 | 无相关文件 |
| Claude 会话日志 | 有增量 `Edit` 记录，见下节 |

## 三、增量回放为什么失败

会话日志记录的是 `Edit` 工具的 `old_string` / `new_string` 对，**是补丁而不是快照**。按时间倒序反向套用（把 `new_string` 换回 `old_string`）18:00 之后的 41 次 Edit：

```
apps/server/src/modules/orchestrator/orchestrator.service.ts    reverted  2/17   failed 15
apps/server/src/modules/sessions/sessions.service.ts            reverted  0/12   failed 12
apps/server/src/modules/sessions/sessions.controller.ts         reverted  0/4    failed  4
packages/shared/src/contracts.ts                                reverted  1/6    failed  5
docs/roadmap/remediation-plan-v1.md                             reverted  1/1    failed  0
docs/analysis/feature-inventory-and-status-v1.md                reverted  1/1    failed  0
=== TOTAL reverted 5, failed 36 ===
```

失败模式统一是 `new_string NOT FOUND`：后续编辑改写了先前 `new_string` 所在区域，锚点已不存在。补丁链一旦中间断裂，后面的都无法回放。代码文件编辑密集（`orchestrator.service.ts` 17 次、`sessions.service.ts` 12 次）所以几乎全断；两个文档各只有 1 次编辑，所以能精确还原。

`docs/design/capability-approval-resume-design.md` 是 18:21:56 的 `Write`（新建，13347B）。"恢复到 18:00 之前"对它等价于**删除该文件**。

## 四、6 个 spec 文件：外部工具批量写入

mtime 集中在 16 毫秒内，是一次批量操作而非逐个编辑：

```
08:48:43.198  context-router.service.spec.ts
08:48:43.199  orchestrator.service.spec.ts
08:48:43.204  runtime-stream-consumer.spec.ts
08:48:43.206  sessions-controller-v2-contract.spec.ts
08:48:43.210  sessions.service.spec.ts
08:48:43.214  workflow-session-flow.spec.ts
```

排查 28 个 Claude 会话日志，对这 6 个文件的写入记录为 **0 条**；`.codex`、`.gemini`、`.agentroom` 在该时间窗内均无活动。推测是 git checkout / stash apply / IDE 批量还原一类的外部操作。**它们 18:00 之前的内容没有任何地方留有记录，不可重建。**

## 五、已建立的备份

```
D:/demo/muti-agent/_restore_backup_20260728_0950/
  full-working-diff.patch   1.0 MB，340 个文件的全量未提交改动
  files/                    13 个目标文件 + .tmpdir.txt 的原样副本
  head.txt                  备份时的 HEAD
  status.txt                备份时的 git status
```

回放脚本（临时产物，未入库）：

- `%TEMP%/scan-edits.mjs` — 从会话日志提取目标文件的编辑时间线
- `%TEMP%/revert-1800.mjs` — 反向套用，默认 dry-run，需 `--apply` 才写入

## 六、方案选项

### 方案 A：只还原 3 个文档（建议）

- 反向套用 `remediation-plan-v1.md`、`feature-inventory-and-status-v1.md`（dry-run 100% 成功）
- `capability-approval-resume-design.md` 需用户确认是否删除
- 10 个代码文件不动
- 优点：精确、可验证、无误伤；缺点：不满足"全部撤销"

### 方案 B：13 个文件全部 `git checkout HEAD --`

- 干净、可完全验证
- **代价：丢失的比要求的多。** 还原点是 7/23 18:27，会一并丢掉 7/23 18:27 → 7/27 18:00 之间约 4 天的工作
- 相关 diff 规模：12 个已跟踪文件 1899 插入 / 362 删除

### 方案 C：不动，保留备份

- 由用户自行审阅 diff 后决定

## 七、待用户决策

1. 选择 A / B / C。
2. 若选 A，明确 `docs/design/capability-approval-resume-design.md` 是否删除。

**当前状态：未写入任何文件，等待决策。**
