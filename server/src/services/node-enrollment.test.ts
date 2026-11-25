import { describe, expect, it } from 'vitest'
import { parseJoinCode } from './node-enrollment.js'

describe('parseJoinCode', () => {
  const enroll = 'ABCDEFGHIJKLMNOP'
  const pairing = '0123456789ABCDEF'

  it('splits a grouped code into its two halves', () => {
    const code = `${enroll}${pairing}`.match(/.{4}/g)!.join('-')
    expect(parseJoinCode(code)).toEqual({ enroll, pairing })
  })

  it('accepts lower case and spaces', () => {
    expect(parseJoinCode(` ${enroll.toLowerCase()} ${pairing.toLowerCase()} `)).toEqual({ enroll, pairing })
  })

  it('reads a retyped 0/1/8 in the enrollment half as O/I/B, and leaves the pairing half alone', () => {
    expect(parseJoinCode(`ABCDEFGH1JKLMN0P${pairing}`)).toEqual({ enroll, pairing })
    expect(parseJoinCode(`A8CDEFGHIJKLMNOP${pairing}`)?.enroll).toBe(enroll)
  })

  it('refuses the wrong length and foreign characters', () => {
    expect(parseJoinCode(enroll)).toBeNull()
    expect(parseJoinCode(`${enroll}${pairing}X`)).toBeNull()
    expect(parseJoinCode(`ABCDEFGHIJKLMNO9${pairing}`)).toBeNull()
  })
})
