import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import SessionWorkspace from '@/components/SessionWorkspace.vue'

const workspaceRoutes: RouteRecordRaw[] = [
  {
    path: '/sessions',
    name: 'workspace-session',
    component: SessionWorkspace,
    meta: { section: 'session' }
  },
  {
    path: '/knowledge',
    name: 'workspace-knowledge',
    component: SessionWorkspace,
    meta: { section: 'knowledge' }
  },
  {
    path: '/agents',
    name: 'workspace-agents',
    component: SessionWorkspace,
    meta: { section: 'agents' }
  },
  {
    path: '/settings',
    name: 'workspace-settings',
    component: SessionWorkspace,
    meta: { section: 'settings' }
  },
  {
    path: '/models',
    name: 'workspace-models',
    component: SessionWorkspace,
    meta: { section: 'models' }
  },
  {
    path: '/tools',
    name: 'workspace-tools',
    component: SessionWorkspace,
    meta: { section: 'tools' }
  },
  {
    path: '/notifications',
    name: 'workspace-notifications',
    component: SessionWorkspace,
    meta: { section: 'notifications' }
  }
]

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: { name: 'workspace-session' }
    },
    ...workspaceRoutes,
    {
      path: '/:pathMatch(.*)*',
      redirect: { name: 'workspace-session' }
    }
  ]
})

