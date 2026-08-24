import {
  buildGitHubReleasesPageUrl,
  detectArchFromUserAgent,
  detectPlatformFromUserAgent,
  loadDownloadConfig,
  normalizeArch,
  normalizePlatform,
  resolveDownloadTarget,
  type DownloadBindings,
} from './_shared/download-config'

interface PagesFunctionContext<Env> {
  request: Request
  env: Env
}

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  'Accept-CH': 'Sec-CH-UA-Platform, Sec-CH-UA-Arch',
  Vary: 'User-Agent, Sec-CH-UA-Platform, Sec-CH-UA-Arch',
}

export async function onRequest(
  context: PagesFunctionContext<DownloadBindings>,
): Promise<Response> {
  try {
    const config = await loadDownloadConfig(context.env)
    const url = new URL(context.request.url)
    const requestPlatform = normalizePlatform(url.searchParams.get('platform'))
    const requestArch = normalizeArch(url.searchParams.get('arch'))
    const headerPlatform = normalizePlatform(
      context.request.headers.get('sec-ch-ua-platform'),
    )
    const headerArch = normalizeArch(
      context.request.headers.get('sec-ch-ua-arch'),
    )
    const userAgent = context.request.headers.get('user-agent') ?? ''
    const platform =
      requestPlatform ??
      headerPlatform ??
      detectPlatformFromUserAgent(userAgent)
    const arch =
      requestArch ?? headerArch ?? detectArchFromUserAgent(userAgent, platform)

    const targetUrl =
      resolveDownloadTarget(config, platform, arch) ??
      buildGitHubReleasesPageUrl(config)

    return new Response(null, {
      status: 302,
      headers: {
        Location: targetUrl,
        ...noStoreHeaders,
      },
    })
  } catch {
    // Config unavailable — fall back to the GitHub Releases page so the user
    // can still grab the binary manually.
    return new Response(null, {
      status: 302,
      headers: {
        Location: 'https://github.com/Nickqiaoo/Operon/releases',
        ...noStoreHeaders,
      },
    })
  }
}
