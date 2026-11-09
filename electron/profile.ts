import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOperonHome } from '../shared/operon-home.js'

// Imported before server modules: many of them resolve state paths at import time.
if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
  process.env.OPERON_DEV = '1'
  process.env.OPERON_HOME ||= path.join(os.homedir(), '.operon-dev')
  const userData = path.join(getOperonHome(), 'electron')
  fs.mkdirSync(userData, { recursive: true })
  app.setName('Operon Dev')
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
}
