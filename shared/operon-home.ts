import os from 'node:os'
import path from 'node:path'

/** App-owned state only. Never change HOME: installed CLIs keep their own login. */
export function getOperonHome(): string {
  return path.resolve(process.env.OPERON_HOME || path.join(os.homedir(), '.operon'))
}

export function isDevelopmentProfile(): boolean {
  return process.env.OPERON_DEV === '1'
}
