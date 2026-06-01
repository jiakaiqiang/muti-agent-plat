## 技术
真正的代码位于 `apps/server/src/modules/<feature>/`（每个为一个 NestJS module，在 `app.module.ts` 中接入）。
同级的顶层目录如 `src/agents/`、`src/runtimes/` 是空的脚手架 —— 请忽略。`main.ts` 设置全局 `/api` 前缀、CORS 以及安全响应头。
## 规则
