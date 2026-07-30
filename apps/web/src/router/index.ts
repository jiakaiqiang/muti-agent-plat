import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { claimRouteRecovery, clearRouteRecovery, isRouteModuleLoadError } from './routeLoadRecovery'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/workspace'
  },
  {
    path: '/workspace',
    name: 'workspace',
    component: () => import('@/components/SessionWorkspace.vue'),
    meta: { section: 'session', title: '工作台' }
  },
  {
    path: '/workspace/:sessionId',
    name: 'workspace-session',
    component: () => import('@/components/SessionWorkspace.vue'),
    meta: { section: 'session', title: '工作台' }
  },
  {
    path: '/local-runtime/activate',
    name: 'local-runtime-activate',
    component: () => import('@/views/LocalRuntimeActivationView.vue'),
    meta: { section: 'settings', title: '连接本机 Runtime' }
  },
  {
    path: '/workflows',
    name: 'workflows',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'workflows' },
    meta: { section: 'workflows', title: '工作流管理' }
  },
  {
    path: '/agents',
    name: 'agents',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'agents' },
    meta: { section: 'agents', title: 'Agent 管理' }
  },
  {
    path: '/skills',
    name: 'skills',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'skills' },
    meta: { section: 'skills', title: 'Skill 管理' }
  },
  {
    path: '/knowledge',
    name: 'knowledge',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'knowledge' },
    meta: { section: 'knowledge', title: '知识库' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'settings' },
    meta: { section: 'settings', title: '设置' }
  },
  {
    path: '/models',
    name: 'models',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'models' },
    meta: { section: 'models', title: '模型管理' }
  },
  {
    path: '/tools',
    name: 'tools',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'tools' },
    meta: { section: 'tools', title: '工具集成' }
  },
  {
    path: '/notifications',
    name: 'notifications',
    component: () => import('@/views/AdminRouteView.vue'),
    props: { section: 'notifications' },
    meta: { section: 'notifications', title: '通知中心' }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/workspace'
  }
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

router.onError((error, to) => {
  if (!isRouteModuleLoadError(error)) return
  console.error(`Route module failed to load: ${to.fullPath}`, error)
  if (typeof window === 'undefined' || !claimRouteRecovery(window.sessionStorage, to.fullPath)) return
  window.location.assign(to.fullPath)
})

router.afterEach((route, _from, failure) => {
  const title = typeof route.meta.title === 'string' ? route.meta.title : '工作台'
  document.title = `${title} · 多 Agent 协同工作平台`
  if (!failure && typeof window !== 'undefined') {
    clearRouteRecovery(window.sessionStorage, route.fullPath)
  }
})
