import { randomInt } from 'node:crypto'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

let lastTimestamp = 0
let counter = 0

/**
 * A message id in OpenCode's own ascending format (`msg_` + 12 hex digits of
 * `ms * 0x1000 + counter` + 14 base62), so one we choose up front sorts where
 * a server-made id from the same moment would. OpenCode orders a session's
 * messages by id, so the format is not cosmetic.
 */
export function createAscendingMessageId(now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now
    counter = 0
  }
  counter += 1
  const time = (BigInt(now) * 0x1000n + BigInt(counter)).toString(16).padStart(12, '0').slice(-12)
  let random = ''
  for (let i = 0; i < 14; i += 1) random += BASE62[randomInt(BASE62.length)]
  return `msg_${time}${random}`
}
