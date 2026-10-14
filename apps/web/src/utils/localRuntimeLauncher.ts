const LOCAL_RUNTIME_SCHEME = 'agent-runtime:'

export function createLocalRuntimeLaunchUrl(serverUrl: string) {
  const launchUrl = new URL(`${LOCAL_RUNTIME_SCHEME}//connect`)
  launchUrl.searchParams.set('server', serverUrl)
  return launchUrl.toString()
}

export function createLocalRuntimeUpgradeUrl(serverUrl: string, upgradeId: string, nonce = createLaunchNonce()) {
  const launchUrl = new URL(`${LOCAL_RUNTIME_SCHEME}//upgrade`)
  launchUrl.searchParams.set('server', serverUrl)
  launchUrl.searchParams.set('upgradeId', upgradeId)
  launchUrl.searchParams.set('nonce', nonce)
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

export function requestLocalRuntimeUpgrade(upgradeUrl: string, documentRef: Document = document) {
  if (typeof window !== 'undefined' && window.agentClusterDesktop) return false
  const link = documentRef.createElement('a')
  link.href = upgradeUrl
  link.hidden = true
  link.setAttribute('aria-hidden', 'true')
  documentRef.body.appendChild(link)
  link.click()
  link.remove()
  return true
}

function createLaunchNonce() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
