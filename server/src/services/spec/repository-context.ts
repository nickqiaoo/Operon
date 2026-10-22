/** Read existing project documentation as design constraints. Spec never generates these files. */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export const ADR_DIR = path.posix.join('docs', 'adr')
export const GLOSSARY_FILE = 'GLOSSARY.md'

/** Cap on the glossary text handed to a prompt; the ADR index is short by nature. */
const MAX_GLOSSARY_CHARS = 12_000

interface RecordedAdr {
  number: number
  title: string
  file: string
}

/** ADRs in a checkout, by number. A file counts when its name starts with its number: `0007-some-slug.md`. */
async function listAdrs(root: string): Promise<RecordedAdr[]> {
  let names: string[]
  try {
    names = await fs.readdir(path.join(root, ADR_DIR))
  } catch {
    return []
  }
  const adrs: RecordedAdr[] = []
  for (const name of names) {
    const match = /^(\d+)-.*\.md$/.exec(name)
    if (!match) continue
    const text = await fs.readFile(path.join(root, ADR_DIR, name), 'utf8').catch(() => '')
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name
    adrs.push({ number: Number(match[1]), title: heading.replace(/^\d+\.\s*/, ''), file: path.posix.join(ADR_DIR, name) })
  }
  return adrs.sort((a, b) => a.number - b.number)
}

/**
 * The decisions and terms a checkout already records, as markdown for a prompt:
 * the ADR index and the glossary. Empty when it has neither.
 */
export async function readRecorded(root: string): Promise<string> {
  const [adrs, glossary] = await Promise.all([
    listAdrs(root),
    fs.readFile(path.join(root, GLOSSARY_FILE), 'utf8').catch(() => null),
  ])
  const parts: string[] = []
  if (adrs.length > 0) {
    parts.push(`### ADRs (${ADR_DIR}/)\n${adrs.map((a) => `- ${pad(a.number)} ${a.title} — \`${a.file}\``).join('\n')}`)
  }
  if (glossary?.trim()) {
    const text = glossary.length > MAX_GLOSSARY_CHARS ? `${glossary.slice(0, MAX_GLOSSARY_CHARS)}\n…(truncated; read ${GLOSSARY_FILE})` : glossary
    parts.push(`### ${GLOSSARY_FILE}\n${text.trim()}`)
  }
  return parts.join('\n\n')
}

function pad(n: number): string {
  return String(n).padStart(4, '0')
}
