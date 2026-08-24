/**
 * Merge ARM and Intel latest-mac.yml into a single file
 * so electron-updater can pick the correct architecture.
 *
 * No external dependencies - parses simple YAML manually.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const releaseDir = path.join(__dirname, '..', 'release')

const armPath = path.join(releaseDir, 'latest-mac-arm64.yml')
const intelPath = path.join(releaseDir, 'latest-mac.yml')

if (!fs.existsSync(armPath)) {
  console.error('latest-mac-arm64.yml not found, skipping merge')
  process.exit(1)
}

const armContent = fs.readFileSync(armPath, 'utf-8')
const intelContent = fs.readFileSync(intelPath, 'utf-8')

// Extract the files array block from a latest-mac.yml string
function extractFilesBlock(content) {
  const lines = content.split('\n')
  const blocks = []
  let inFiles = false
  let current = null

  for (const line of lines) {
    if (line.startsWith('files:')) {
      inFiles = true
      continue
    }
    if (inFiles) {
      if (line.startsWith('  - url:')) {
        if (current) blocks.push(current)
        current = [line]
      } else if (line.startsWith('    ') && current) {
        current.push(line)
      } else if (!line.startsWith('  ') && !line.startsWith('    ')) {
        if (current) blocks.push(current)
        break
      }
    }
  }
  if (current && !blocks.includes(current)) blocks.push(current)
  return blocks
}

// Extract top-level field
function extractField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim().replace(/^'|'$/g, '') : null
}

const armFiles = extractFilesBlock(armContent)
const intelFiles = extractFilesBlock(intelContent)
const allFiles = [...armFiles, ...intelFiles]

const version = extractField(armContent, 'version')
const armZipPath = extractField(armContent, 'path')
const armSha512 = extractField(armContent, 'sha512')
const releaseDate = extractField(armContent, 'releaseDate') || extractField(intelContent, 'releaseDate')

const output = [
  `version: ${version}`,
  'files:',
  ...allFiles.flatMap(block => block),
  `path: ${armZipPath}`,
  `sha512: ${armSha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n')

fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), output, 'utf-8')
console.log('Merged latest-mac.yml with both ARM and Intel files:')
console.log(output)
