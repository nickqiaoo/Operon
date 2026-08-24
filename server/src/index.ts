import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { startServer } from './start.js'

const port = parseInt(process.env.OPERON_PORT || '3100', 10)
const dataDir = process.env.OPERON_DATA_DIR || path.join(os.homedir(), '.operon', 'data')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(__dirname, 'storage', 'migrations')

startServer({
  dbPath: path.join(dataDir, 'operon.db'),
  migrationsDir,
  port,
  // A headless node has no UI to show a pairing QR or to approve a device, so
  // pairing one can only be done by curling the local-only routes over SSH,
  // twice, inside the 5-minute code lifetime. That is fine for a machine whose
  // owner is at a keyboard and impossible for the App Store review node, whose
  // reviewer we never share a moment with. Such a node opts out here.
  //
  // This is not a hole in the product: packaged desktop builds hardcode
  // 'required' (electron/main.ts), so no ordinary user's machine can reach this
  // setting, and the default stays 'required' for headless nodes too.
  remoteE2eeMode: process.env.OPERON_REMOTE_E2EE === 'off' ? 'off' : 'required',
})
