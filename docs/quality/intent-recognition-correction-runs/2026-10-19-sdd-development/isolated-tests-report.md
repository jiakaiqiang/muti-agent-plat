# 隔离测试执行器开发记录

日期：2026-10-19。依据 Spec、Plan、Task、Checklist 推进 IR05 的实际执行隔离基础。此记录不表示 run_tests 新意图已获自动派发权限，也不表示完整 IRC-AC03 通过。

## 代码与执行边界

新增 IsolatedTestRunnerService，并作为可选执行通道接入现有 TestRunnerTool/RuntimeModule。服务端必须显式配置 `INTENT_ISOLATED_TEST_IMAGE=sha256:<64 位 hash>`；不接受标签、模型镜像、任意 Docker 参数或任意 shell。仅允许 test/test:unit/test:integration 脚本。单次测试上限 120 秒；源码快照上限 20,000 文件/128 MiB，输出最多 256,000 字符。

执行前生成独立快照并计算内容 hash，排除敏感文件、.git、node_modules、构建输出与工具配置目录；拒绝 symlink/junction、特殊文件及读取期间变化。快照挂载到 /input 且只读，测试在 /scratch 的复制品运行。镜像根文件系统只读，UID/GID 65534、cap-drop ALL、no-new-privileges、网络 none、独立 IPC；限制进程/CPU/内存，禁用镜像 healthcheck，拒绝镜像声明的额外 VOLUME。测试进程用 env -i，宿主环境凭据不传入。npm 不自动运行 pre/post 生命周期脚本，也不安装依赖。依赖环境必须另行预备，不能据此声称能运行所有仓库。

策略依据是 Docker 官方的 [容器运行参数](https://docs.docker.com/reference/cli/docker/container/run) 与 [网络隔离说明](https://docs.docker.com/engine/network/)。这里只证明已测试的工程边界，不声称容器消除了所有内核隔离风险。

每次执行使用唯一容器名；超时或取消后强制删除该容器，再检查确实不存在。无法确认时返回 ISOLATED_TEST_STOP_UNCONFIRMED、stopConfirmed=false、cleanupRequired=true，保留快照用于核对；适配器将其作为非重试错误并传递 stopUnconfirmed，避免 Runtime 将未知进程当作已结束。适配器 cancel 现在实际传播到测试 AbortSignal。

现有测试能力审批仍先执行。要求隔离但缺少配置时拒绝调用，不退回宿主命令。旧合同未配置隔离时保留旧通道；没有静默为整个产品开启容器测试。直接调用测试适配器也检查 intent scope；当前新合同 run_tests 仍由能力策略拒绝，下一阶段必须先接授权与版本化计划派发。

## 实际环境与验证

本机 Docker Linux Server 29.6.2。现有应用镜像不含 Node，因此只为隔离测试拉取官方 node:22-alpine，使用固定 ID `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`。没有改生产环境变量或业务模型连接。

真实容器测试通过服务和 TestRunnerTool 两个入口验证：/input 源码不可写、宿主源码内容保持不变、敏感 .env 不存在、宿主标记环境变量不可见、容器根目录不可写、非 root 身份、scratch 可写但不回写宿主、对保留测试地址的外连失败。另启动长期运行的子进程，超时后确认整个容器被删除。测试日志中的该用例没有跳过。

单元故障注入覆盖：不固定镜像/任意脚本拒绝、取消前零调用、快照敏感过滤和 hash、固定 Docker 参数、执行前回调失败阻止启动、符号链接拒绝、删除失败保持停止未知与快照、缺配置禁止宿主回退、TAP 数量解析、取消信号及错误传递。

最初回归有一项旧参数合同比较失败，原因是新增 false 字段改变调用形状；已改为仅新合同带该字段并通过回归。最初与最终日志分别保留。全量后端测试启动后补加适配器入口的 scope 检查，最终相关回归与构建覆盖这项增量。本轮全量后端 2054 项及开发脚本 7 项通过、21 项 PostgreSQL 跳过；最终相关回归 104 项通过且包含真实 Docker 用例，最终 Server 构建与 Harness 检查通过。结束时无 intent-test-* 残留容器。本轮没有改客户端，也未重跑全仓前端测试。命令、测试计数、源码 hash 见 `isolated-tests-manifest.json`。

## 待完成

run_tests 的用户授权、runner 资源绑定、分类候选、版本计划派发、每次真正启动前的事务重验、停止未知的持久化恢复/对账与界面仍须接通。beforeLaunch 是隔离服务提供的能力，不代表调用方已完成所有版本事务检查。CLI/Codex/Claude 测试权限拆分、源码/报告执行器、业务调度和完整场景仍未完成，IR05 不勾选。真实 PostgreSQL、完整双客户端、独立人工标注和发布门继续保留。
