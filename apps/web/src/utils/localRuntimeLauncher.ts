const LOCAL_RUNTIME_SCHEME = 'agent-runtime:'

export function resolveLocalRuntimeServerUrl(apiBaseUrl: string, pageOrigin: string) {
  const resolved = new URL(apiBaseUrl || '/api', pageOrigin)
  resolved.pathname = '/'
  resolved.search = ''
  resolved.hash = ''
  return resolved.origin
}

export function createLocalRuntimeLaunchUrl(serverUrl: string) {
  const launchUrl = new URL(`${LOCAL_RUNTIME_SCHEME}//connect`)
  launchUrl.searchParams.set('server', serverUrl)
  return launchUrl.toString()
}

export function requestLocalRuntimeLaunch(launchUrl: string, documentRef: Document = document) {
  const link = documentRef.createElement('a')
  link.href = launchUrl
  link.hidden = true
  link.setAttribute('aria-hidden', 'true')
  documentRef.body.appendChild(link)
  link.click()
  link.remove()
}
