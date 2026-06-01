---
name: frontend-coding-guidelines
description: 为前端开发任务提供统一的 Vue 3、Element Plus、TypeScript、CSS 与测试编码规范和实现流程。用于编写或修改基于 Vue 3 与 Element Plus 的页面、组件、Composition API、Pinia 状态管理、Vue Router 路由、表单、表格、弹窗、接口请求、样式、可访问性与测试代码；当用户要求“按规范写 Vue3 + Element Plus 代码”“补一个后台页面/表单/表格”“优化一致性、类型安全或交互质量”时使用。
---

# Frontend Coding Guidelines

## 目标

按一致、可维护、类型安全、易测试的标准完成 Vue 3 + Element Plus 前端代码。优先遵循仓库现有约定；本技能用于在约定缺失、冲突或不完整时补齐默认规范。

## 执行流程

1. 先识别项目约束：Vue 版本、构建工具、路由方案、Pinia 或其他状态方案、Element Plus 接入方式、样式方案、测试框架、目录结构。
2. 先沿用现有模式：若仓库已明确使用某套 Element Plus 二次封装、请求封装、命名风格或样式方案，优先保持一致，不强行引入新范式。
3. 先定义边界：明确页面、组件、组合式函数、store、服务层的职责，以及加载、空态、错误态；先判断是直接使用 Element Plus 组件还是复用项目内二次封装组件。
4. 先做最小实现：先搭出模板结构和数据流，再补交互、样式、测试和细节优化。
5. 先验证再结束：至少检查类型、lint、构建和关键交互；无法验证时明确说明缺口。

## 基线规则

- 保持单一职责。页面负责组装，组件负责展示和局部交互，复杂业务逻辑下沉到 composables、stores、services 或 utils。
- 保持接口清晰。显式声明 props、emits、返回值与错误分支，避免隐式约定。
- 优先使用精确类型。避免裸 `any`；必须使用时写明原因并缩小作用域。
- 控制响应式状态数量。能由 props、路由、服务端数据或计算属性表达的内容，不额外落本地状态。
- 保持数据流单向。props 向下，事件或 store action 向上，不跨层级隐式改值。
- 处理完整 UI 状态。加载、空态、错误态、禁用态、提交中态都应有明确表现。
- 优先复用 Element Plus 与项目内封装能力，不重复造按钮、表单项、弹窗、表格、分页等基础交互。
- 保持实现可读。命名直接表达业务含义；函数短小；模板分支和嵌套层级受控。
- 注释只解释意图、约束或非显然权衡，不注释表面代码。

## 默认实现约定

- Vue 3 组件优先使用 `<script setup lang="ts">`，除非仓库已有强约束要求其他写法。
- TypeScript 项目中优先使用 `type` 描述 props、返回结构和联合类型；仅在需要声明合并或面向对象扩展时使用 `interface`。
- Props 使用 `defineProps` 显式声明，事件使用 `defineEmits` 显式约束，不依赖隐式约定。
- 可派生状态优先使用 `computed`，不要把计算值重复存成 `ref`。
- 副作用放进 `watch`、`watchEffect` 或生命周期钩子，并及时清理订阅、计时器与未完成请求。
- 基础交互优先选择 Element Plus 官方组件与项目二次封装，不自造功能等价组件。
- 表单提交路径必须考虑校验失败、请求失败和重复点击。
- 列表渲染使用稳定 key，不使用索引作为动态列表 key，除非列表静态且不可重排。
- 样式优先复用现有 design tokens、Element Plus tokens、变量和组件，不直接散落魔法数字与硬编码颜色。

## 任务决策

- 编写 Vue 3 组件、组合式函数、Pinia、路由状态逻辑时，读取 [references/vue3-typescript.md](references/vue3-typescript.md)。
- 编写 Element Plus 表单、表格、弹窗、消息反馈、主题覆盖或组件封装时，读取 [references/element-plus.md](references/element-plus.md)。
- 编写样式、布局、响应式或可访问性交互时，读取 [references/styling-accessibility.md](references/styling-accessibility.md)。
- 补测试、跑自检、准备交付说明时，读取 [references/testing-delivery.md](references/testing-delivery.md)。

## 输出要求

- 给出实现时，默认产出可直接落库的代码，而不是停留在建议层。
- 新增文件时保持目录语义清晰，避免把页面、组件、composables、stores、types、utils 混在同一层。
- 修改已有文件时保留既有风格，除非当前风格已经明显破坏可维护性。
- 完成后简要说明做了什么、为什么这么做、验证了什么、还有什么未验证。
