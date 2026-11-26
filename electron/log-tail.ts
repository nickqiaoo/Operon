import { open } from 'node:fs/promises'

// Scan backwards so opening Settings normally reads only a few KiB.
export async function readLogTail(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    let position = (await file.stat()).size
    let lines = 0
    const chunks: Buffer[] = []
    while (position > 0) {
      const length = Math.min(position, 32 * 1024)
      position -= length
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await file.read(buffer, 0, length, position)
      const chunk = buffer.subarray(0, bytesRead)
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] === 10 && ++lines === 500) {
          chunks.push(chunk.subarray(i + 1))
          return Buffer.concat(chunks.reverse()).toString('utf8')
        }
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks.reverse()).toString('utf8')
  } finally {
    await file.close()
  }
}
