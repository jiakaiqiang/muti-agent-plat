# M4-07 · 新增 `WorkdirBriefService`（临时目录 only）

> 状态：✅ 已完成（2026-07-10）  
> 实际实现：除 staging 生命周期外，已扩展 manifest、sidecar、lease、恢复和 TTL 管理。

## 目标

新建 `apps/server/src/modules/runtimes/streaming/workdir-brief.service.ts`：负责创建 `~/.agent-cluster/workspaces/<session>/<task>/` 临时目录并管理生命周期（创建/清理）。**本任务只做目录生命周期，不写 brief 文件。**

## 依赖

M4-06。

## 前置阅读

- 上游设计第 7 节 R5 概设
- 现有 `apps/server/src/common/` 是否有 fs 工具

## 测试步骤（红）

`workdir-brief.spec.ts`：

1. `provisionWorkdir(sessionId, taskId)` 创建目录、返回绝对路径
2. 同参数再调 → 返回同一路径且不报错（幂等）
3. `cleanupWorkdir(path)` 删除目录
4. cleanup 不存在的路径不抛错
5. 拒绝 provisioning 到非临时目录（防御性检查：如传入 `/etc/passwd` 抛错）

## 实现要点（绿）

- 用 `fs/promises.mkdir({recursive:true})`
- 路径校验：必须在 `os.homedir() + '/.agent-cluster/workspaces'` 之内
- `cleanupWorkdir` 用 `fs.rm({recursive:true, force:true})`

## 验收目标

- [ ] 5 用例绿
- [ ] `typecheck` 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M4-07): 新增 WorkdirBriefService 临时目录生命周期
```

## 常见坑

- 路径校验必须严格——防止上层 bug 传错路径把用户其他目录删掉
