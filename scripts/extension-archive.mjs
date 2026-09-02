import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let value = n
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

const uint16 = (value) => {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16LE(value)
  return bytes
}

const uint32 = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value >>> 0)
  return bytes
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

async function collectFiles(root, current = root) {
  const files = []
  for (const name of (await readdir(current)).sort()) {
    const fullPath = path.join(current, name)
    if ((await stat(fullPath)).isDirectory()) files.push(...await collectFiles(root, fullPath))
    else files.push({ name: path.relative(root, fullPath).split(path.sep).join('/'), data: await readFile(fullPath) })
  }
  return files
}

/** Build a deterministic zip for an already-built extension directory. */
export async function archiveExtension(extensionDir) {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'))
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) throw new Error('manifest.json must declare a non-empty string "id"')
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('manifest.json must declare a non-empty string "version"')

  const files = await collectFiles(extensionDir)
  const locals = []
  const centrals = []
  let offset = 0
  const dosTime = 0x0000
  const dosDate = 0x0021
  const utf8Flag = 0x0800

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const packed = deflateRawSync(file.data, { level: 9 })
    const checksum = crc32(file.data)
    const local = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(utf8Flag), uint16(8), uint16(dosTime), uint16(dosDate),
      uint32(checksum), uint32(packed.length), uint32(file.data.length), uint16(name.length), uint16(0), name, packed,
    ])
    centrals.push(Buffer.concat([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(utf8Flag), uint16(8), uint16(dosTime), uint16(dosDate),
      uint32(checksum), uint32(packed.length), uint32(file.data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]))
    locals.push(local)
    offset += local.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
    uint32(centralDirectory.length), uint32(offset), uint16(0),
  ])
  const bytes = Buffer.concat([...locals, centralDirectory, end])
  return {
    bytes,
    files: files.map((file) => file.name),
    manifest,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
