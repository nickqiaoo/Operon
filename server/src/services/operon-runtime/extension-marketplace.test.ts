import { describe, expect, it } from 'vitest'
import { compareVersions, isOutdated, parseMarketplaceIndex } from './extension-marketplace.js'

const validEntry = {
  id: 'peers',
  name: 'Teams',
  description: 'Team collaboration.',
  version: '1.3.29',
  engine: '0.1.0-alpha.2',
  minOperonVersion: '1.3.29',
  requiresServices: ['operon-teams'],
  publisher: { id: 'operon', name: 'Operon', verified: true },
  sha256: 'a'.repeat(64),
  size: 1024,
  downloadUrl: 'https://extensions.operon.chatcode.top/v1/extensions/peers/1.3.29/download',
}

describe('extension marketplace index', () => {
  it('parses a valid first-party entry', () => {
    const parsed = parseMarketplaceIndex({ schemaVersion: 1, generatedAt: '2026-09-02T00:00:00Z', extensions: [validEntry] })
    expect(parsed.extensions[0]).toMatchObject({ id: 'peers', publisher: { verified: true } })
  })

  it('rejects artifacts hosted outside the configured marketplace', () => {
    expect(() => parseMarketplaceIndex({
      schemaVersion: 1,
      generatedAt: '2026-09-02T00:00:00Z',
      extensions: [{ ...validEntry, downloadUrl: 'https://example.com/peers.zip' }],
    })).toThrow(/must stay on/)
  })

  it('compares release and prerelease versions', () => {
    expect(compareVersions('1.3.29', '1.3.28')).toBeGreaterThan(0)
    expect(compareVersions('1.3.29-alpha.2', '1.3.29')).toBeLessThan(0)
  })
})

describe('isOutdated', () => {
  const installed = (version: string, engine: string) =>
    ({ id: 'peers', state: 'loaded', version, engine, attachedSessions: 0 }) as Parameters<typeof isOutdated>[0]

  it('sees a newer app-side build', () => {
    expect(isOutdated(installed('1.3.29', '0.1.0-alpha.2'), { ...validEntry, version: '1.3.30' })).toBe(true)
  })

  // The case a version-only comparison missed: the framework package inside the bundle
  // moved, so the artifact really is different, while `version` did not.
  it('sees a newer framework under an unchanged version', () => {
    expect(isOutdated(installed('1.3.29', '0.1.0-alpha.2'), { ...validEntry, engine: '0.1.0-alpha.3' })).toBe(true)
  })

  it('is not outdated when neither moved', () => {
    expect(isOutdated(installed('1.3.29', '0.1.0-alpha.2'), validEntry)).toBe(false)
  })

  it('does not treat an older marketplace entry as an update', () => {
    expect(isOutdated(installed('1.3.30', '0.1.0-alpha.3'), validEntry)).toBe(false)
  })
})
