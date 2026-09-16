const LOCAL_RUNTIME_SCHEME = 'agent-runtime:'

export function createLocalRuntimeLaunchUrl(serverUrl: string) {
  const launchUrl = new URL(`${LOCAL_RUNTIME_SCHEME}//connect`)
  launchUrl.searchParams.set('server', serverUrl)
  return launchUrl.toString()
}

export function requestLocalRuntimeLaunch(launchUrl: string, documentRef: Document = document) {
  if (typeof window !== 'undefined' && window.agentClusterDesktop) {
    void window.agentClusterDesktop.startRuntime().catch(() => undefined)
    return
  }
  const link = documentRef.createElement('a')
  link.href = launchUrl
  link.hidden = true
  link.setAttribute('aria-hidden', 'true')
  documentRef.body.appendChild(link)
  link.click()
  link.remove()
}
