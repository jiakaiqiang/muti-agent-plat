# Verification Result 验证结果模板

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

> 规程来源：[README.md](../README.md) §7 Agent Role Protocol、§8 Stage Workflow
> 阶段：`verification`　产出 Agent：`test`
> 输入：Intent Contract + Implementation Summary　输出：Verification Result

## 使用说明

- 这是 Verification 阶段的交接产物，供 Review 阶段继续使用。
- Verification Agent **只验证需求与设计是否被满足，不主导需求变更**（见 [03-agent-role-protocol.md](../03-agent-role-protocol.md)）。
- 验证逐条对照 Intent Contract 的验收标准，每条给出 `pass` / `fail` / `blocked` 与证据。
- 验证只是研发交付流程中的一个阶段，不是整个 Harness 的核心。

---

## 模板正文

```markdown
---
artifact: verification_summary
stage: verification
producedBy: test
schemaVersion: "0.1"
status: draft            # draft | ready
result: pending          # pass | fail | partial
deliveryId: <本次交付编号>
createdAt: <ISO 8601>
intentContractRef: <需求契约编号或标题>
implementationSummaryRef: <实现摘要编号或标题>
---

# Verification Result: <标题>

## 验收标准核对 (Acceptance Checklist)
- [x] AC1 <验收标准> — pass — 证据：<命令 / 输出 / 文件>
- [ ] AC2 <验收标准> — fail — 证据：<失败输出>
- [ ] AC3 <验收标准> — blocked — 原因：<阻塞原因>

## 测试执行 (Test Execution)
- 命令 / 用例：`npm run test:e2e:<...>`
- 结果摘要：通过 / 失败数、关键日志。

## 证据 (Evidence)
- 关键输出、截图路径、artifact 引用。

## 缺陷 (Defects)
- D1：现象 / 影响 / 复现步骤 / 疑似根因（无写 `无`）。

## 结论 (Verdict)
- result: pass | fail | partial
- 未通过的验收标准清单 + 建议回退阶段。
```

---

## 完成标准 (Definition of Done)

- Intent Contract 的**每条**验收标准都有 `pass` / `fail` / `blocked` 判定与证据。
- 每个 `fail` / `blocked` 都有可执行的复现信息或阻塞原因。
- `result` 字段与逐条核对结果一致（任一 fail 则不可为 `pass`）。
- `status = ready` 后才进入 Review 阶段。

## 交接 (Handoff)

- 下游消费者：Review Agent（Review 阶段）。
- 若验证失败：按 [07-feedback-loop.md](../07-feedback-loop.md) 归类——实现问题回 `implementation`，验证方式本身有问题回 `verification`，需求/设计问题上报由 Review 决定。

