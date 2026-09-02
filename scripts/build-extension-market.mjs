import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPeersExtension } from './build-peers-extension.mjs'
import { archiveExtension } from './extension-archive.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist-extension-market')
const work = await mkdtemp(path.join(os.tmpdir(), 'operon-extension-market-'))

try {
  const extensionDir = await buildPeersExtension({ root, outdir: path.join(work, 'runtime') })
  const archive = await archiveExtension(extensionDir)
  const app = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const { id, name, description, version, engine } = archive.manifest
  const artifactPath = `/artifacts/${id}/${version}/${id}-${version}.zip`
  const artifactFile = path.join(output, artifactPath.slice(1))

  await rm(output, { recursive: true, force: true })
  await mkdir(path.dirname(artifactFile), { recursive: true })
  await mkdir(path.join(output, '_market'), { recursive: true })
  await writeFile(artifactFile, archive.bytes)

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    extensions: [{
      id,
      name,
      description,
      version,
      engine,
      minOperonVersion: app.version,
      requiresServices: ['operon-teams'],
      publisher: { id: 'operon', name: 'Operon', verified: true },
      artifact: {
        path: artifactPath,
        sha256: archive.sha256,
        size: archive.bytes.length,
        files: archive.files,
      },
    }],
  }
  await writeFile(path.join(output, '_market', 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  console.log(`extension market: ${id}@${version} ${archive.bytes.length} bytes sha256 ${archive.sha256}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
