import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Harness } from 'operon-agents'
import { EXTENSIONS_DIR } from './paths.js'
import { getOperonHarness } from './index.js'

/**
 * File-extension management — session-independent, drives `harness.extensions` directly.
 *
 * An extension is a folder under `EXTENSIONS_DIR` holding `manifest.json` + a bundle; the
 * framework lists every folder with a trust state and only ever runs one through an explicit
 * `load` (that call IS the approval, recorded at the bundle's mtime). Nothing watches the
 * directory: a bundle that changed on disk lists as `changed` until the user reloads it. This
 * module adds the install path (zip from a URL or bytes, sha256-checked, extracted into place)
 * and removal; everything else is a thin wrapper so the Settings page and the Agent panel see
 * exactly what the framework sees.
 */

export type OperonExtensionState = 'loaded' | 'approved' | 'new' | 'changed' | 'error'

export interface OperonExtensionDTO {
  id: string
  state: OperonExtensionState
  name?: string
  version?: string
  engine?: string
  description?: string
  error?: string
  /** Extension ids of the sessions currently holding it — for "used by N sessions". */
  attachedSessions: number
}

async function manager(): Promise<NonNullable<Harness['extensions']>> {
  const harness = await getOperonHarness()
  if (!harness.extensions) throw new Error('File extensions are not enabled on this harness')
  return harness.extensions
}

export async function listExtensions(): Promise<OperonExtensionDTO[]> {
  const harness = await getOperonHarness()
  if (!harness.extensions) return []
  const statuses = await harness.extensions.list()
  const attached = new Map<string, number>()
  for (const session of harness.sessions.values()) {
    for (const id of session.attachedExtensionIds()) attached.set(id, (attached.get(id) ?? 0) + 1)
  }
  return statuses.map((s) => ({
    id: s.id,
    state: s.state,
    ...(s.name ? { name: s.name } : {}),
    ...(s.version ? { version: s.version } : {}),
    ...(s.engine ? { engine: s.engine } : {}),
    ...(s.description ? { description: s.description } : {}),
    ...(s.error ? { error: s.error } : {}),
    attachedSessions: attached.get(s.id) ?? 0,
  }))
}

/** Load (= approve) or hot-reload one extension. */
export async function loadExtension(id: string): Promise<void> {
  await (await manager()).load(assertId(id))
}

export async function reloadExtension(id: string): Promise<void> {
  await (await manager()).reload(assertId(id))
}

export async function unloadExtension(id: string): Promise<void> {
  await (await manager()).unload(assertId(id))
}

/** Unload if loaded, then delete the folder. State under `.data/<id>` is kept on purpose. */
export async function removeExtension(id: string): Promise<void> {
  const safe = assertId(id)
  const m = await manager()
  const current = (await m.list()).find((s) => s.id === safe)
  if (current?.state === 'loaded') await m.unload(safe)
  await rm(path.join(EXTENSIONS_DIR, safe), { recursive: true, force: true })
}

export interface InstallInput {
  /** `https://…/<id>-<version>.zip`, or an index entry json (`{ file, sha256, … }`). */
  url?: string
  /** Raw zip bytes, base64 — the file-picker path. */
  zipBase64?: string
  /** Expected sha256 of the zip (hex); when given the install is refused on mismatch. */
  sha256?: string
}

export interface InstallExpectation {
  id: string
  version: string
  /** Exact byte size published by the marketplace. */
  size: number
}

/** Install from a zip: verify → extract to a staging dir → check manifest → move into place. */
export async function installExtension(input: InstallInput, expectation?: InstallExpectation): Promise<OperonExtensionDTO> {
  let bytes: Buffer
  let expected = input.sha256?.trim().toLowerCase()
  if (input.zipBase64) {
    bytes = Buffer.from(input.zipBase64, 'base64')
  } else if (input.url) {
    const url = input.url.trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be installed')
    if (new URL(url).pathname.endsWith('.json')) {
      const entry = (await fetchJson(url)) as { file?: string; sha256?: string }
      if (!entry.file) throw new Error('Index entry has no "file"')
      const zipUrl = new URL(entry.file, url).toString()
      bytes = await fetchBytes(zipUrl, expectation !== undefined)
      expected ??= entry.sha256?.trim().toLowerCase()
    } else {
      bytes = await fetchBytes(url, expectation !== undefined)
    }
  } else {
    throw new Error('Provide a url or zip bytes')
  }
  if (bytes.length === 0) throw new Error('Empty archive')
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Archive larger than 64 MB')
  if (expectation && bytes.length !== expectation.size) {
    throw new Error(`Archive size mismatch: expected ${expectation.size}, got ${bytes.length}`)
  }
  if (expected) {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`)
  }

  const staging = await mkdtemp(path.join(os.tmpdir(), 'operon-ext-'))
  try {
    for (const entry of readZip(bytes)) {
      const target = path.join(staging, entry.name)
      if (!target.startsWith(staging + path.sep)) throw new Error(`Refusing zip entry outside the archive: ${entry.name}`)
      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, entry.data)
    }
    const manifestPath = path.join(staging, 'manifest.json')
    let manifest: { id?: unknown; version?: unknown }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { id?: unknown; version?: unknown }
    } catch {
      throw new Error('Archive has no manifest.json at its root')
    }
    if (typeof manifest.id !== 'string') throw new Error('manifest.json declares no "id"')
    const id = assertId(manifest.id)
    if (expectation?.id !== undefined && id !== expectation.id) {
      throw new Error(`Extension id mismatch: marketplace says "${expectation.id}", archive says "${id}"`)
    }
    if (expectation?.version !== undefined && manifest.version !== expectation.version) {
      throw new Error(`Extension version mismatch: marketplace says "${expectation.version}", archive says "${String(manifest.version)}"`)
    }
    // Update = an atomic folder swap. If copying or renaming the new build fails, the
    // previously installed extension stays byte-for-byte in place.
    await swapExtension(staging, id)
    const listed = (await listExtensions()).find((e) => e.id === id)
    if (!listed) throw new Error(`Installed ${id} but it is not listed`)
    return listed
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const ID = /^[A-Za-z0-9_.-]{1,64}$/
function assertId(id: string): string {
  const trimmed = id.trim()
  if (!ID.test(trimmed) || trimmed === '.' || trimmed === '..') throw new Error(`Invalid extension id: ${id}`)
  return trimmed
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json()
}

async function fetchBytes(url: string, trustedMarketplace: boolean): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Accept: 'application/zip' },
    redirect: trustedMarketplace ? 'error' : 'follow',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function swapExtension(staging: string, id: string): Promise<void> {
  await mkdir(EXTENSIONS_DIR, { recursive: true })
  const swapRoot = await mkdtemp(path.join(EXTENSIONS_DIR, '.install-'))
  const next = path.join(swapRoot, 'next')
  const previous = path.join(swapRoot, 'previous')
  const destination = path.join(EXTENSIONS_DIR, id)
  let heldPrevious = false
  try {
    await copyDir(staging, next)
    try {
      await rename(destination, previous)
      heldPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(next, destination)
    } catch (error) {
      if (heldPrevious) await rename(previous, destination)
      throw error
    }
  } finally {
    await rm(swapRoot, { recursive: true, force: true })
  }
}

async function copyDir(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const name of await readdir(from)) {
    const src = path.join(from, name)
    const dst = path.join(to, name)
    if ((await stat(src)).isDirectory()) await copyDir(src, dst)
    else await writeFile(dst, await readFile(src))
  }
}

interface ZipEntry {
  name: string
  data: Buffer
}

const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024

/**
 * Minimal zip reader: central directory → local headers, stored (0) or deflate (8) only —
 * what `pack-extension.mjs` (and every ordinary zip tool) produces. Zip64 is out of scope.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let extractedBytes = 0
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt zip local header')
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    const normalized = name.replace(/\\/g, '/')
    if (normalized.split('/').some((seg) => seg === '..')) throw new Error(`Refusing zip entry: ${name}`)
    if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Zip entry larger than 64 MB: ${name}`)
    extractedBytes += uncompressedSize
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('Archive expands beyond 128 MB')
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`)
    if (data.length !== uncompressedSize) throw new Error(`Zip entry size mismatch: ${name}`)
    entries.push({ name: normalized, data })
  }
  return entries
}
