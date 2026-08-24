function isDocumentNavigation(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false

  return (
    request.headers.get("Sec-Fetch-Mode") === "navigate" ||
    request.headers.get("Accept")?.includes("text/html") === true
  )
}

export default {
  async fetch(request, env) {
    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404 || !isDocumentNavigation(request)) {
      return assetResponse
    }

    const appShellUrl = new URL(request.url)
    appShellUrl.pathname = "/"
    appShellUrl.search = ""
    appShellUrl.hash = ""

    return env.ASSETS.fetch(new Request(appShellUrl, request))
  },
}
