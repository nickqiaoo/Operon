import fs from 'fs'

const [, , version, changelogPath = 'CHANGELOG.md'] = process.argv

if (!version) {
  console.error('Usage: node scripts/extract-release-notes.mjs <version> [changelog-path]')
  process.exit(1)
}

if (!fs.existsSync(changelogPath)) {
  console.error(`Changelog file not found: ${changelogPath}`)
  process.exit(1)
}

const content = fs.readFileSync(changelogPath, 'utf8')
const lines = content.split(/\r?\n/)
const startPattern = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+.+)?$`)
const section = []
let inSection = false

for (const line of lines) {
  if (!inSection) {
    if (startPattern.test(line)) {
      inSection = true
    }
    continue
  }

  if (/^## \[.+\]/.test(line)) {
    break
  }

  section.push(line)
}

const notes = trimEmptyLines(section).join('\n').trimEnd()

if (!inSection) {
  console.error(`Version ${version} not found in ${changelogPath}`)
  process.exit(1)
}

if (!notes) {
  console.error(`No release notes found for version ${version} in ${changelogPath}`)
  process.exit(1)
}

process.stdout.write(`${notes}\n`)

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimEmptyLines(linesToTrim) {
  let start = 0
  let end = linesToTrim.length

  while (start < end && linesToTrim[start].trim() === '') {
    start += 1
  }

  while (end > start && linesToTrim[end - 1].trim() === '') {
    end -= 1
  }

  return linesToTrim.slice(start, end)
}
