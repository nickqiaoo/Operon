import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { readZip } from './extensions.js'

describe('readZip', () => {
  it('reads deflated and stored entries with nested paths', () => {
    const files = {
      'manifest.json': new TextEncoder().encode(JSON.stringify({ id: 'demo', version: '1.0.0' })),
      'index.js': new TextEncoder().encode('export default { id: "demo", setup() {} }'),
      'assets/readme.txt': new TextEncoder().encode('hello'),
    }
    const deflated = zipSync(files, { level: 9 })
    const stored = zipSync(files, { level: 0 })
    for (const bytes of [deflated, stored]) {
      const entries = readZip(Buffer.from(bytes))
      const byName = Object.fromEntries(entries.map((e) => [e.name, e.data.toString('utf8')]))
      expect(byName['manifest.json']).toContain('"id":"demo"')
      expect(byName['index.js']).toContain('export default')
      expect(byName['assets/readme.txt']).toBe('hello')
    }
  })

  it('refuses path traversal entries', () => {
    const bytes = zipSync({ '../evil.js': new TextEncoder().encode('x') })
    expect(() => readZip(Buffer.from(bytes))).toThrow(/Refusing/)
  })

  it('rejects non-zip input', () => {
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/Not a zip/)
  })
})
