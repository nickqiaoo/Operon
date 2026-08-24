export type DownloadPlatform = 'mac' | 'windows' | 'linux'
export type DownloadArch = 'arm64' | 'x64'

interface NavigatorUADataValues {
  architecture?: string
  platform?: string
}

const normalizePlatform = (value: string | null | undefined): DownloadPlatform | null => {
  if (!value) return null

  const normalized = value.trim().toLowerCase()
  if (normalized.includes('mac') || normalized.includes('darwin')) return 'mac'
  if (normalized.includes('win')) return 'windows'
  if (normalized.includes('linux')) return 'linux'
  return null
}

const normalizeArch = (value: string | null | undefined): DownloadArch | null => {
  if (!value) return null

  const normalized = value.trim().toLowerCase()
  if (normalized === 'arm64' || normalized === 'aarch64' || normalized === 'arm') {
    return 'arm64'
  }

  if (
    normalized === 'x64' ||
    normalized === 'x86_64' ||
    normalized === 'amd64' ||
    normalized === 'x86'
  ) {
    return 'x64'
  }

  return null
}

const detectPlatformFromUserAgent = (userAgent: string): DownloadPlatform | null => {
  const ua = userAgent.toLowerCase()

  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac'
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('linux')) return 'linux'
  return null
}

const detectArchFromUserAgent = (
  userAgent: string,
  platform: DownloadPlatform | null,
): DownloadArch | null => {
  const ua = userAgent.toLowerCase()

  if (ua.includes('aarch64') || ua.includes('arm64')) return 'arm64'
  if (ua.includes('x86_64') || ua.includes('win64') || ua.includes('amd64')) {
    return 'x64'
  }

  if (platform === 'mac' && ua.includes('intel')) {
    return 'x64'
  }

  return null
}

const createDownloadPath = (
  source: string,
  platform: DownloadPlatform | null,
  arch: DownloadArch | null,
): string => {
  const params = new URLSearchParams()
  params.set('source', source)

  if (platform) {
    params.set('platform', platform)
  }

  if (arch) {
    params.set('arch', arch)
  }

  return `/download?${params.toString()}`
}

async function detectClientHints(): Promise<{
  platform: DownloadPlatform | null
  arch: DownloadArch | null
}> {
  const uaData = navigator.userAgentData
  const basicPlatform = normalizePlatform(uaData?.platform)

  if (!uaData?.getHighEntropyValues) {
    return {
      platform: basicPlatform,
      arch: null,
    }
  }

  try {
    const hints = (await uaData.getHighEntropyValues([
      'architecture',
      'platform',
    ])) as NavigatorUADataValues

    return {
      platform: normalizePlatform(hints.platform) ?? basicPlatform,
      arch: normalizeArch(hints.architecture),
    }
  } catch {
    return {
      platform: basicPlatform,
      arch: null,
    }
  }
}

export function getDownloadHref(source: string): string {
  return createDownloadPath(source, null, null)
}

export async function redirectToDownload(source: string): Promise<void> {
  const clientHints = await detectClientHints()
  const userAgent = navigator.userAgent
  const platform = clientHints.platform ?? detectPlatformFromUserAgent(userAgent)
  const arch = clientHints.arch ?? detectArchFromUserAgent(userAgent, platform)

  window.location.assign(createDownloadPath(source, platform, arch))
}
