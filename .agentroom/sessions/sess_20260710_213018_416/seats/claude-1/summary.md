---
summary: |
  分析了 D:\work\机器人统一平台\mr_pro_web\apps\mp_robot_vue 的项目架构，
  产出中文架构报告 mp_robot_vue-architecture-report.md，覆盖技术栈、目录结构、
  业务域反推、状态管理/路由/hooks 组织、以及 10 个待审查的可疑点，并给出
  codex-1 可直接执行的核查命令清单。因 worktree 权限限制，未能读取目标目录
  内 README.md/package.json/vite.config.js/permission.js/request 拦截器等具体
  文件内容，版本号推断自 public/cdn/ 目录的文件名，需 codex-1 授权后核实。
  按 AgentRoom 编排规则，本座位不主动派发 codex-1，由 AgentRoom TUI 完成路由。
changed_files:
  - mp_robot_vue-architecture-report.md
  - AGENTROOM_SUMMARY.md
tests:
  - 无：仅产出分析文档，未修改任何代码，无验证命令可跑
claims:
  - 项目技术栈（版本号推断自 public/cdn 文件名）：Vue 3.4.27、Vue Router 4.3.2、Vuex 4.1.0、Element Plus 2.10.6、axios 0.21.1、ECharts 5.6.0、jQuery 3.7.1、ROS 系列（roslibjs/ros2djs/nav2djs/easeljs/eventemitter2），实际 package.json 未读到，需下游核实
  - 使用 Avue 后台管理框架（src/router/avue-router.js + src/config/website.js 均存在）
  - 源码全为 .js，未使用 TypeScript
  - src/api 规模超 1200 个文件（Glob 匹配 1284，含分片）
  - 存在 Legacy 顶层 API（src/api/alarm、asset、robot、robotConfig）与新架构 src/api/biz/{common,it} 双层并存，biz/ 下没有 ct/ 子域，重构未完成
  - src/page/index 与 src/page/indexEveningTheme 是两套完整分叉的布局代码，夜间主题以目录 fork 方式实现
  - src/utils/gogocodeTransfer.js 存在，暗示项目由 Vue 2 迁移而来
  - src/utils/robotStatusCompat.js 暗示机器人状态字段口径曾发生变更
  - 命名规范存在多处拼写错误：ErrorrQue.js、validateExcation.js、updataPwdDialog.vue、verSion.js
  - src/api/robot/ 下 taskManage.js 与 taskManagement.js 同目录并存，疑似重复实现
  - src/store/modules/auth/ 下 user.js 与 userInfo.js 并存，疑似重复
  - src/api/hasOperatePermi/ 与 src/components/hasOperatePermi/ 同名不同职责，容易误用
  - 依赖安全隐患：axios 0.21.1 存在 CVE-2021-3749（ReDoS）和 CVE-2023-45857（CSRF token 泄露）等已知漏洞
  - dist/ 目录中出现 cdn/img 等构建产物，是否被提交需核查 .gitignore
  - 交付物 mp_robot_vue-architecture-report.md 提供了 8 条具体核查命令供 codex-1 直接执行（读 package.json、vite.config.js、permission.js、axios.js、legacy vs biz URL diff、jQuery 使用面、夜间主题 diff）
  - 未主动向 codex-1 派发消息：遵循 AgentRoom 编排规则，跨座位路由留给 AgentRoom TUI
---

# 交付物

- **mp_robot_vue-architecture-report.md** —— 中文架构分析报告，7 个章节：
  1. 技术栈画像（含版本表）
  2. 目录组织
  3. 业务模块反推（Legacy vs biz/）
  4. 关键架构点（路由/状态/hooks/utils/页面）
  5. 潜在问题（🔴🟠🟡 三档共 10 条）
  6. 交给下游 code review 的具体核查命令
  7. 结论与建议审查主线

# 建议 codex-1 优先审查的三条主线

1. **依赖安全**：axios 0.21.1 的 CVE 与升级路径评估
2. **Legacy vs biz/ 冗余**：告警/资产/机器人三个域的双层 API 引用面比对与废弃计划
3. **请求层与权限守卫**：src/router/axios.js + src/permission.js 的实际实现是否完备

# 数据来源可信度

- ✅ 高可信：目录结构、文件命名、public/cdn 版本号（来自 Glob 输出）
- ⚠️ 待核实：package.json 实际依赖版本、vite.config.js externals 配置、请求层拦截器细节、路由守卫逻辑

# 未完成 / 后续

- Explore 子代理受 worktree 权限限制，未能读取目标目录内 .md / .json / .js 文件正文
- 建议 codex-1 在拥有目标目录读权限的座位执行报告第 6 节列出的 8 条命令后再展开代码审查
- 本座位遵循 AgentRoom 编排规则未派发 codex-1，由 AgentRoom TUI 处理跨座位路由
