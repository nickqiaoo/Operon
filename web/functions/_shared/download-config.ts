export type DownloadPlatform = 'mac' | 'windows' | 'linux'
export type DownloadArch = 'arm64' | 'x64'
export type DownloadTargetKey =
  | 'mac-arm64'
  | 'mac-x64'
  | 'windows-arm64'
  | 'windows-x64'
  | 'linux-arm64'
  | 'linux-x64'

export interface DownloadAssetConfig {
  fileName?: string
  url?: string
}

export interface GitHubReleaseConfig {
  owner: string
  repo: string
  tag?: string
  tagPrefix?: string
}

export interface DownloadConfig {
  version: string
  github: GitHubReleaseConfig
  files: Partial<Record<DownloadTargetKey, DownloadAssetConfig>>
  fallbacks?: Partial<Record<DownloadPlatform, DownloadTargetKey>>
  defaultTarget?: DownloadTargetKey
}

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>
}

export interface DownloadBindings {
  DOWNLOAD_CONFIG_KV?: KVNamespaceLike
  DOWNLOAD_CONFIG_KEY?: string
}

const defaultKvKey = 'download:stable'

const allTargetKeys = new Set<DownloadTargetKey>([
  'mac-arm64',
  'mac-x64',
  'windows-arm64',
  'windows-x64',
  'linux-arm64',
  'linux-x64',
])

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const normalizeTargetKey = (value: string): DownloadTargetKey | null => {
  return allTargetKeys.has(value as DownloadTargetKey)
    ? (value as DownloadTargetKey)
    : null
}

const parseGitHubConfig = (value: unknown): GitHubReleaseConfig => {
  if (!isRecord(value)) {
    throw new Error('Missing github configuration.')
  }

  const owner = typeof value.owner === 'string' ? value.owner.trim() : ''
  const repo = typeof value.repo === 'string' ? value.repo.trim() : ''
  const tag = typeof value.tag === 'string' ? value.tag.trim() : undefined
  const tagPrefix =
    typeof value.tagPrefix === 'string' ? value.tagPrefix.trim() : undefined

  if (!owner || !repo) {
    throw new Error('github.owner and github.repo are required.')
  }

  return {
    owner,
    repo,
    tag: tag || undefined,
    tagPrefix: tagPrefix || undefined,
  }
}

const parseAsset = (value: unknown): DownloadAssetConfig | null => {
  if (typeof value === 'string') {
    const fileName = value.trim()
    return fileName ? { fileName } : null
  }

  if (!isRecord(value)) {
    return null
  }

  const fileName =
    typeof value.fileName === 'string' ? value.fileName.trim() : undefined
  const url = typeof value.url === 'string' ? value.url.trim() : undefined

  if (!fileName && !url) {
    return null
  }

  return {
    fileName,
    url,
  }
}

const parseFiles = (
  value: unknown,
): Partial<Record<DownloadTargetKey, DownloadAssetConfig>> => {
  if (!isRecord(value)) {
    throw new Error('files configuration is required.')
  }

  const parsed: Partial<Record<DownloadTargetKey, DownloadAssetConfig>> = {}

  for (const [key, rawAsset] of Object.entries(value)) {
    const normalizedKey = normalizeTargetKey(key)
    if (!normalizedKey) continue

    const asset = parseAsset(rawAsset)
    if (!asset) continue

    parsed[normalizedKey] = asset
  }

  if (Object.keys(parsed).length === 0) {
    throw new Error('files configuration must define at least one download target.')
  }

  return parsed
}

const parseFallbacks = (
  value: unknown,
): Partial<Record<DownloadPlatform, DownloadTargetKey>> | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const parsed: Partial<Record<DownloadPlatform, DownloadTargetKey>> = {}

  const platformEntries: Array<[DownloadPlatform, unknown]> = [
    ['mac', value.mac],
    ['windows', value.windows],
    ['linux', value.linux],
  ]

  for (const [platform, rawTarget] of platformEntries) {
    if (typeof rawTarget !== 'string') continue

    const target = normalizeTargetKey(rawTarget)
    if (target) {
      parsed[platform] = target
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined
}

export const normalizePlatform = (
  value: string | null | undefined,
): DownloadPlatform | null => {
  if (!value) return null

  const normalized = value.replace(/"/g, '').trim().toLowerCase()
  if (normalized.includes('mac') || normalized.includes('darwin')) return 'mac'
  if (normalized.includes('win')) return 'windows'
  if (normalized.includes('linux')) return 'linux'
  return null
}

export const normalizeArch = (
  value: string | null | undefined,
): DownloadArch | null => {
  if (!value) return null

  const normalized = value.replace(/"/g, '').trim().toLowerCase()
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

export const detectPlatformFromUserAgent = (
  userAgent: string,
): DownloadPlatform | null => {
  const ua = userAgent.toLowerCase()

  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac'
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('linux')) return 'linux'
  return null
}

export const detectArchFromUserAgent = (
  userAgent: string,
  platform: DownloadPlatform | null,
): DownloadArch | null => {
  const ua = userAgent.toLowerCase()

  if (ua.includes('aarch64') || ua.includes('arm64')) return 'arm64'
  if (ua.includes('x86_64') || ua.includes('amd64') || ua.includes('win64')) {
    return 'x64'
  }

  if (platform === 'mac' && ua.includes('intel')) {
    return 'x64'
  }

  return null
}

const parseDownloadConfig = (raw: string): DownloadConfig => {
  const data: unknown = JSON.parse(raw)

  if (!isRecord(data)) {
    throw new Error('Download config must be a JSON object.')
  }

  const version = typeof data.version === 'string' ? data.version.trim() : ''
  if (!version) {
    throw new Error('version is required.')
  }

  const defaultTarget =
    typeof data.defaultTarget === 'string'
      ? normalizeTargetKey(data.defaultTarget)
      : null

  return {
    version,
    github: parseGitHubConfig(data.github),
    files: parseFiles(data.files),
    fallbacks: parseFallbacks(data.fallbacks),
    defaultTarget: defaultTarget ?? undefined,
  }
}

export const buildGitHubReleaseUrl = (
  config: DownloadConfig,
  fileName: string,
): string => {
  const tag =
    config.github.tag ?? `${config.github.tagPrefix ?? 'v'}${config.version}`
  const encodedFileName = fileName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return `https://github.com/${config.github.owner}/${config.github.repo}/releases/download/${encodeURIComponent(
    tag,
  )}/${encodedFileName}`
}

export const buildGitHubReleasesPageUrl = (config: DownloadConfig): string => {
  return `https://github.com/${config.github.owner}/${config.github.repo}/releases`
}

export const resolveDownloadTarget = (
  config: DownloadConfig,
  platform: DownloadPlatform | null,
  arch: DownloadArch | null,
): string | null => {
  const candidateKeys: DownloadTargetKey[] = []

  if (platform && arch) {
    candidateKeys.push(`${platform}-${arch}` as DownloadTargetKey)
  }

  if (platform) {
    const fallback = config.fallbacks?.[platform]
    if (fallback) {
      candidateKeys.push(fallback)
    }
  }

  if (config.defaultTarget) {
    candidateKeys.push(config.defaultTarget)
  }

  const defaultPlatformTargets: Record<DownloadPlatform, DownloadTargetKey> = {
    mac: 'mac-arm64',
    windows: 'windows-x64',
    linux: 'linux-x64',
  }

  if (platform) {
    candidateKeys.push(defaultPlatformTargets[platform])
  }

  for (const key of candidateKeys) {
    const asset = config.files[key]
    if (!asset) continue

    if (asset.url) {
      return asset.url
    }

    if (asset.fileName) {
      return buildGitHubReleaseUrl(config, asset.fileName)
    }
  }

  return null
}

export const loadDownloadConfig = async (
  env: DownloadBindings,
): Promise<DownloadConfig> => {
  const kvKey = env.DOWNLOAD_CONFIG_KEY || defaultKvKey

  const kvValue = await env.DOWNLOAD_CONFIG_KV?.get(kvKey)
  if (kvValue) {
    return parseDownloadConfig(kvValue)
  }

  throw new Error(
    'Missing download config. Bind DOWNLOAD_CONFIG_KV in your Cloudflare Pages project.',
  )
}
