import fs from 'fs'
import path from 'path'

const electronBuilderArchNames = new Map([
  [1, 'x64'],
  [3, 'arm64'],
])

function getTargetArch(context) {
  if (typeof context.arch === 'number') {
    return electronBuilderArchNames.get(context.arch) ?? process.arch
  }
  if (typeof context.arch === 'string') {
    return context.arch
  }
  return process.arch
}

/**
 * afterPack hook for electron-builder.
 * Fixes permissions for native executables that need to be signed.
 */
export default async function afterPack(context) {
  const appName = context.packager.appInfo.productFilename
  const targetArch = getTargetArch(context)
  const resourcesDir = path.join(
    context.appOutDir,
    `${appName}.app`,
    'Contents', 'Resources',
  )

  const executablePaths = [
    path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@lydell', `node-pty-${process.platform}-${targetArch}`, 'spawn-helper'),
  ]

  for (const executablePath of executablePaths) {
    if (!fs.existsSync(executablePath)) continue
    fs.chmodSync(executablePath, 0o755)
  }
}
