import appPackage from '../../../../package.json'
import enginePackage from 'operon-agents/package.json'
import { TEAMS_SERVICE } from '../../extensions/peers/contract.js'
import { installExtension, listExtensions, type OperonExtensionDTO } from './extensions.js'

const DEFAULT_MARKET_URL = 'https://extensions.operon.chatcode.top'
const FALLBACK_MARKET_URL = 'https://operon-extension-market.nickqiaoo.workers.dev'
const MARKET_URLS = process.env.OPERON_EXTENSION_MARKET_URL
  ? [process.env.OPERON_EXTENSION_MARKET_URL.replace(/\/$/, '')]
  : [DEFAULT_MARKET_URL, FALLBACK_MARKET_URL]
const SUPPORTED_HOST_SERVICES: ReadonlySet<string> = new Set([TEAMS_SERVICE])
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export type ExtensionMarketplaceStatus = 'available' | 'installed' | 'update' | 'incompatible'

export interface ExtensionPublisherDTO {
  id: string
  name: string
  verified: boolean
}

export interface ExtensionMarketplaceEntryDTO {
  id: string
  name: string
  description: string
  version: string
  engine: string
  minOperonVersion: string
  requiresServices: string[]
  publisher: ExtensionPublisherDTO
  sha256: string
  size: number
  downloadUrl: string
  status: ExtensionMarketplaceStatus
  compatibilityReason?: string
  installedVersion?: string
  installedState?: OperonExtensionDTO['state']
}

interface RemoteMarketplaceIndex {
  schemaVersion: number
  generatedAt: string
  extensions: RemoteMarketplaceEntry[]
}

interface RemoteMarketplaceEntry {
  id: string
  name: string
  description: string
  version: string
  engine: string
  minOperonVersion: string
  requiresServices: string[]
  publisher: ExtensionPublisherDTO
  sha256: string
  size: number
  downloadUrl: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Marketplace field "${field}" must be a non-empty string`)
  return value.trim()
}

const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Marketplace field "${field}" must be an array of strings`)
  }
  return value.map((item) => String(item).trim())
}

function parseEntry(value: unknown, marketUrl: string): RemoteMarketplaceEntry {
  if (!isRecord(value)) throw new Error('Marketplace extension entry must be an object')
  const publisher = value.publisher
  if (!isRecord(publisher)) throw new Error('Marketplace publisher must be an object')
  const downloadUrl = requiredString(value.downloadUrl, 'downloadUrl')
  const marketOrigin = new URL(marketUrl).origin
  const artifactUrl = new URL(downloadUrl)
  if (artifactUrl.origin !== marketOrigin) throw new Error(`Marketplace artifact must stay on ${marketOrigin}`)
  if (marketOrigin.startsWith('https://') && artifactUrl.protocol !== 'https:') throw new Error('Marketplace artifact must use HTTPS')

  const size = value.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new Error('Marketplace field "size" must be a positive integer')
  const sha256 = requiredString(value.sha256, 'sha256').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Marketplace field "sha256" must be a 64-character hex digest')

  return {
    id: requiredString(value.id, 'id'),
    name: requiredString(value.name, 'name'),
    description: requiredString(value.description, 'description'),
    version: requiredString(value.version, 'version'),
    engine: requiredString(value.engine, 'engine'),
    minOperonVersion: requiredString(value.minOperonVersion, 'minOperonVersion'),
    requiresServices: stringArray(value.requiresServices, 'requiresServices'),
    publisher: {
      id: requiredString(publisher.id, 'publisher.id'),
      name: requiredString(publisher.name, 'publisher.name'),
      verified: publisher.verified === true,
    },
    sha256,
    size,
    downloadUrl: artifactUrl.toString(),
  }
}

export function parseMarketplaceIndex(value: unknown, marketUrl = DEFAULT_MARKET_URL): RemoteMarketplaceIndex {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.generatedAt !== 'string' || !Array.isArray(value.extensions)) {
    throw new Error('Unsupported extension marketplace index')
  }
  const extensions = value.extensions.map((entry) => parseEntry(entry, marketUrl))
  const ids = new Set<string>()
  for (const extension of extensions) {
    if (ids.has(extension.id)) throw new Error(`Marketplace contains duplicate extension id "${extension.id}"`)
    ids.add(extension.id)
  }
  return { schemaVersion: 1, generatedAt: value.generatedAt, extensions }
}

export function compareVersions(a: string, b: string): number {
  const left = VERSION_RE.exec(a)
  const right = VERSION_RE.exec(b)
  if (!left || !right) throw new Error(`Invalid version: ${!left ? a : b}`)
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return difference
  }
  const leftPre = left[4]
  const rightPre = right[4]
  if (leftPre === undefined && rightPre === undefined) return 0
  if (leftPre === undefined) return 1
  if (rightPre === undefined) return -1
  return leftPre.localeCompare(rightPre, undefined, { numeric: true })
}

/**
 * Whether an installed extension is behind what the marketplace offers.
 *
 * A bundle has two independent sources — the app's own extension code and the framework
 * package it carries (the Teams bundle is mostly `operon-agents-peers`) — so comparing one
 * version leaves the other's changes invisible. A framework release that fixes a peers bug
 * ships a genuinely different bundle under an unchanged `version`, and this would have read
 * it as up to date; `engine` is what moves in that case, and it is already recorded on both
 * sides. Either one going forward means there is something new to install.
 */
export function isOutdated(local: OperonExtensionDTO, entry: RemoteMarketplaceEntry): boolean {
  if (local.version && compareVersions(local.version, entry.version) < 0) return true
  return Boolean(local.engine && compareVersions(local.engine, entry.engine) < 0)
}

function compatibilityReason(entry: RemoteMarketplaceEntry): string | undefined {
  if (compareVersions(appPackage.version, entry.minOperonVersion) < 0) return `Requires Operon ${entry.minOperonVersion} or later`
  if (compareVersions(enginePackage.version, entry.engine) < 0) return `Requires operon-agents ${entry.engine} or later`
  const missing = entry.requiresServices.filter((service) => !SUPPORTED_HOST_SERVICES.has(service))
  if (missing.length > 0) return `Requires unavailable host service${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
  return undefined
}

async function fetchMarketplace(): Promise<RemoteMarketplaceIndex> {
  let lastError: unknown
  for (const marketUrl of MARKET_URLS) {
    try {
      const response = await fetch(`${marketUrl}/v1/extensions`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) throw new Error(`Extension marketplace returned ${response.status}`)
      return parseMarketplaceIndex(await response.json(), marketUrl)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Extension marketplace is unavailable')
}

export async function listMarketplaceExtensions(): Promise<{ generatedAt: string; extensions: ExtensionMarketplaceEntryDTO[] }> {
  const [marketplace, installed] = await Promise.all([fetchMarketplace(), listExtensions()])
  const installedById = new Map(installed.map((extension) => [extension.id, extension]))
  return {
    generatedAt: marketplace.generatedAt,
    extensions: marketplace.extensions.map((entry) => {
      const local = installedById.get(entry.id)
      const reason = compatibilityReason(entry)
      const status: ExtensionMarketplaceStatus = reason
        ? 'incompatible'
        : !local
          ? 'available'
          : isOutdated(local, entry)
            ? 'update'
            : 'installed'
      return {
        ...entry,
        status,
        ...(reason ? { compatibilityReason: reason } : {}),
        ...(local?.version ? { installedVersion: local.version } : {}),
        ...(local ? { installedState: local.state } : {}),
      }
    }),
  }
}

export async function installMarketplaceExtension(id: string): Promise<OperonExtensionDTO> {
  const marketplace = await fetchMarketplace()
  const entry = marketplace.extensions.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`Extension "${id}" is not in the Operon marketplace`)
  const reason = compatibilityReason(entry)
  if (reason) throw new Error(reason)
  return installExtension(
    { url: entry.downloadUrl, sha256: entry.sha256 },
    { id: entry.id, version: entry.version, size: entry.size },
  )
}
