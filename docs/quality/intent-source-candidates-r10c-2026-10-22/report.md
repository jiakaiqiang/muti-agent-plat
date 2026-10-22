# M-014 A / R10c 源码授权候选文件报告

## 结论

A 已完成。服务端新增 no-store 候选接口，候选只来自请求绑定的 `server_local` 根目录；授权决定只接受候选引用，服务端重新验证引用、根目录身份、文件 `dev/ino/hash`、过期时间和总大小后才签发 authority。

## 行为

- 候选扫描只返回已存在的普通 UTF-8 文本文件，过滤 symlink / junction / hardlink、二进制、超单文件上限、敏感路径、`.env`、密钥类文件、生成目录，并应用根 `.gitignore`。
- `query` 按相对路径过滤；分页固定上限 50，候选总量固定上限 500；响应返回 `nextCursor`、`total`、`truncated`。
- `suggested` 只来自服务端只读证据（工作区快照、补充上下文解析路径和路由语义证据），不会自动进入批准清单。
- 引用为绑定请求、根身份和文件事实的不可猜 opaque ref，并带过期时间。决定体若包含旧 `paths` 字段会被拒绝；伪造、跨请求、过期、文件改动和根身份变化均拒绝。

## 验证

- `intent-follow-up.service.spec.ts` 定向：12/12 通过，覆盖过滤、敏感文件、`.gitignore`、分页上限、suggested 默认不授权、`paths` 拒绝、伪造/跨请求/过期/改动引用拒绝。
- R10a + R10b 32 文件回归：782 项，780 通过，0 失败，2 跳过（操作系统限制相关既有跳过）；逐项原始日志在 `evidence/r10a-r10b-regression.log`。
- `npm run typecheck -w @agent-cluster/server`：通过。
- `npm run build -w @agent-cluster/server`：通过。
- SHA-256 与受保护文件清单见 `evidence/verification.json`。

## 范围

A 仅修改 shared 合同、源码候选/授权服务、候选接口控制器和对应测试夹具；未修改编译器、`execution-scope-resolver`、semantic-intent-router、runtime policy、默认开关或 `.env`，未调用真实模型、未提交或推送。
