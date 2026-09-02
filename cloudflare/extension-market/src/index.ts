interface AssetBinding {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>
}

interface Env {
  ASSETS: AssetBinding
}

interface StoredExtension {
  id: string
  name: string
  description: string
  version: string
  engine: string
  minOperonVersion: string
  requiresServices: string[]
  publisher: { id: string; name: string; verified: boolean }
  artifact: { path: string; sha256: string; size: number; files: string[] }
}

interface StoredIndex {
  schemaVersion: 1
  generatedAt: string
  extensions: StoredExtension[]
}

const API_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Content-Type': 'application/json; charset=utf-8',
}

const json = (body: unknown, status = 200, cacheControl = 'public, max-age=60, stale-while-revalidate=300') =>
  Response.json(body, { status, headers: { ...API_HEADERS, 'Cache-Control': cacheControl } })

async function loadIndex(request: Request, env: Env): Promise<StoredIndex> {
  const response = await env.ASSETS.fetch(new URL('/_market/index.json', request.url))
  if (!response.ok) throw new Error(`market index asset returned ${response.status}`)
  return response.json<StoredIndex>()
}

const publicEntry = (request: Request, entry: StoredExtension) => ({
  id: entry.id,
  name: entry.name,
  description: entry.description,
  version: entry.version,
  engine: entry.engine,
  minOperonVersion: entry.minOperonVersion,
  requiresServices: entry.requiresServices,
  publisher: entry.publisher,
  sha256: entry.artifact.sha256,
  size: entry.artifact.size,
  files: entry.artifact.files,
  downloadUrl: new URL(`/v1/extensions/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.version)}/download`, request.url).toString(),
})

async function download(request: Request, env: Env, entry: StoredExtension): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL(entry.artifact.path, request.url))
  if (!asset.ok || asset.body === null) return json({ error: 'Artifact not found' }, 404, 'no-store')
  const headers = new Headers(asset.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('Content-Type', 'application/zip')
  headers.set('Content-Disposition', `attachment; filename="${entry.id}-${entry.version}.zip"`)
  headers.set('X-Content-SHA256', entry.artifact.sha256)
  return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_HEADERS })
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405, 'no-store')

    const url = new URL(request.url)
    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ ok: true, service: 'operon-extension-market', version: 1 }, 200, 'no-store')
      }

      const index = await loadIndex(request, env)
      if (url.pathname === '/v1/extensions') {
        return json({ schemaVersion: index.schemaVersion, generatedAt: index.generatedAt, extensions: index.extensions.map((entry) => publicEntry(request, entry)) })
      }

      const match = /^\/v1\/extensions\/([^/]+)(?:\/([^/]+)\/download)?$/.exec(url.pathname)
      if (!match) return json({ error: 'Not found' }, 404, 'no-store')
      const id = decodeURIComponent(match[1] ?? '')
      const entry = index.extensions.find((candidate) => candidate.id === id)
      if (!entry) return json({ error: 'Extension not found' }, 404, 'no-store')
      const requestedVersion = match[2] ? decodeURIComponent(match[2]) : undefined
      if (requestedVersion !== undefined) {
        if (requestedVersion !== entry.version) return json({ error: 'Extension version not found' }, 404, 'no-store')
        return download(request, env, entry)
      }
      return json({ extension: publicEntry(request, entry) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 500, 'no-store')
    }
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> }
