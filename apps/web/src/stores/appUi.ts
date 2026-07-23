import { defineStore } from 'pinia'

export type RouteRenderError = {
  path: string
  message: string
  info?: string
}

export const useAppUiStore = defineStore('appUi', {
  state: () => ({
    routeRenderError: undefined as RouteRenderError | undefined
  }),
  actions: {
    captureRouteRenderError(error: unknown, path: string, info?: string) {
      this.routeRenderError = {
        path,
        message: error instanceof Error ? error.message : '页面渲染失败',
        ...(info ? { info } : {})
      }
    },
    clearRouteRenderError() {
      this.routeRenderError = undefined
    }
  }
})
