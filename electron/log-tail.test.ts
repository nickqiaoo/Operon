import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readLogTail } from './log-tail.js'

it('returns the last 500 lines across chunk and UTF-8 boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operon-log-tail-'))
  try {
    const path = join(dir, 'log')
    const lines = Array.from({ length: 800 }, (_, i) => i + '日志'.repeat(60)).join('\n')
    for (const text of ['', lines, lines + '\n']) {
      await writeFile(path, text)
      expect(await readLogTail(path)).toBe(text.split('\n').slice(-500).join('\n'))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
