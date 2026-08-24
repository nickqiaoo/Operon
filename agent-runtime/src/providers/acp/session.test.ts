import { describe, expect, it } from 'vitest'
import { normalizeAcpError } from './session.js'

describe('normalizeAcpError', () => {
  it('preserves the message from a JSON-RPC error response', () => {
    const message =
      'Rate limited: "API error (status 429 Too Many Requests): subscription:free-usage-exhausted"'

    const error = normalizeAcpError({
      code: -32000,
      message,
      data: { status: 429 },
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(message)
  })

  it('keeps native errors unchanged', () => {
    const original = new Error('Native failure')

    expect(normalizeAcpError(original)).toBe(original)
  })
})
