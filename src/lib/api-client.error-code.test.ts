import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestVia, type ApiTransport } from './api-client'

const transport: ApiTransport = {
  baseUrl: async () => 'http://server/api',
  baseUrlSync: () => 'http://server/api',
  authHeaders: () => ({}),
  withTokenQuery: (url) => url,
}

const failWith = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))

afterEach(() => vi.restoreAllMocks())

describe('ApiError code', () => {
  it('reads a code from `code` or from an `error` that is one', async () => {
    failWith(409, { error: 'delegation_key_missing', code: 'delegation_key_missing', message: 'Update Operon' })
    await expect(requestVia(transport, '/x')).rejects.toMatchObject({ status: 409, code: 'delegation_key_missing', message: 'Update Operon' })

    failWith(503, { error: 'node_offline', message: 'The machine is offline' })
    await expect(requestVia(transport, '/x')).rejects.toMatchObject({ code: 'node_offline' })
  })

  it('leaves the code empty when `error` is a sentence', async () => {
    failWith(500, { error: 'Something broke here' })
    const error = await requestVia(transport, '/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBeUndefined()
    expect((error as ApiError).message).toBe('Something broke here')
  })
})
