# Vue 3 与 TypeScript 细则

## 组件设计

- 让一个组件只做一件事。页面负责组装，业务块负责交互，基础组件负责视觉复用。
- Props 保持最小化；不要把仅供内部使用的中间态暴露给上层。
- 先判断是否应该复用项目内已有的 Element Plus 二次封装组件，而不是直接重复拼装相同结构。
- 能通过插槽、组合或拆分子组件解决的问题，不用超大配置对象堆进去。
- 复杂模板分支提取成小组件或具名计算属性，避免模板承载过多业务判断。

## `<script setup>`

- 默认使用 `<script setup lang="ts">`。
- 顶层声明按顺序组织：imports、types、props/emits、router/store/composables、state、computed、methods、watch/lifecycle。
- 不在模板中堆叠复杂表达式；复杂逻辑回收到 `computed` 或具名函数。

## 类型约束

- 为 props、API 响应、表单值、组合式函数返回值、store state 明确声明类型。
- 优先使用联合类型表达状态机，如 `idle | loading | success | error`。
- 用 `unknown` 代替无约束输入，再在边界处收窄类型。
- 避免滥用类型断言；若必须断言，尽量贴近数据来源并说明原因。
- 公共类型放到靠近领域的位置，不创建脱离业务语义的“万能 types 文件”。

## 响应式状态

- 只保留真正会变化、且无法直接推导的状态。
- 标量或可替换引用优先使用 `ref`，对象集合优先使用 `reactive` 或结构化 `ref`，但不要为了一致性机械套用。
- 可由其他状态推导的值使用 `computed`，不要重复维护。
- 不直接解构会失去响应性的对象；需要解构时使用 `storeToRefs`、`toRefs` 或明确说明。

## Composition API

- 自定义 composable 负责复用状态逻辑，不负责渲染。
- composable 名称使用 `useXxx`，返回值优先使用对象并暴露稳定语义。
- composable 只暴露调用方真正需要的状态和动作，不泄露内部实现细节。
- 有副作用的 composable 要处理卸载清理，避免组件销毁后继续写状态。

## 生命周期与监听

- `onMounted`、`onUnmounted`、`watch`、`watchEffect` 只处理副作用：订阅、计时器、网络请求、外部系统同步。
- 不把“计算值”塞进 `watch`；可同步计算的内容直接用 `computed`。
- 使用 `watch` 时明确依赖源和触发目的，避免把多个业务混在一个 watcher 中。
- 清理订阅、计时器和未完成请求，避免内存泄漏或过期结果回写。

## Pinia 与路由

- 跨页面共享且具有业务语义的状态再进入 Pinia，不把局部 UI 状态一股脑塞进 store。
- Store 中 action 负责业务动作，getter 负责派生值，组件不直接拼装复杂业务规则。
- 路由参数和 query 视为外部输入，进入组件或 store 前先做校验和默认值处理。
- 导航守卫、权限判断和重定向逻辑集中管理，不分散在多个组件里复制。

## 数据请求

- 把请求封装在 service 或 data layer，组件和 composable 只处理调用与展示状态。
- 为请求显式处理加载、成功、失败、重试和取消。
- 在并发或快速切换场景下防止旧请求覆盖新结果。
- 不在多个页面里复制相同请求拼装逻辑；抽成共享函数或 composable。

## 事件与交互

- 事件处理函数聚焦业务动作，不在模板里堆叠大段匿名逻辑。
- 连续点击会触发重复请求时，加锁、禁用按钮或去抖，避免重复提交。
- destructive action 提供确认、撤销或清晰提示。

## 代码组织

- 页面级文件只保留页面组装逻辑，细节组件按功能拆分。
- `composables/` 放状态复用，`stores/` 放全局业务状态，`services/` 放请求或副作用边界，`utils/` 放纯函数。
- `components/business/` 或同类目录优先放二次封装的业务组件，避免页面直接堆叠大量 Element Plus 细节。
- 一个文件过长或同时承载多个职责时拆分；不要等到难以 review 再处理。
