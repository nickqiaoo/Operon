import { beforeEach, describe, expect, it } from 'vitest'
import { clearLoadFailure, loadFailure, recordLoadFailure, recordRepairOutcome } from './extension-load-failures.js'

describe('extension load failures', () => {
  beforeEach(() => {
    for (const id of ['peers', 'other']) clearLoadFailure(id)
  })

  it('keeps the reason an import failed', () => {
    recordLoadFailure('peers', new Error('engine 1.4.0 is newer than this build'))
    expect(loadFailure('peers')).toEqual({ message: 'engine 1.4.0 is newer than this build' })
  })

  it('annotates a recorded failure with what the marketplace pass found', () => {
    recordLoadFailure('peers', new Error('boom'))
    recordRepairOutcome('peers', 'unavailable')
    expect(loadFailure('peers')).toEqual({ message: 'boom', repair: 'unavailable' })
  })

  // The sync pass annotates every trusted extension, healthy ones included — it stays quiet on
  // them only because there is nothing recorded to annotate.
  it('does not invent a failure for an extension that loaded', () => {
    recordRepairOutcome('other', 'unavailable')
    expect(loadFailure('other')).toBeUndefined()
  })

  it('forgets the failure once the extension loads', () => {
    recordLoadFailure('peers', new Error('boom'), 'failed')
    clearLoadFailure('peers')
    expect(loadFailure('peers')).toBeUndefined()
  })
})
