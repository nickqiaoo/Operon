import os from 'os'
import path from 'path'

/** Root for all operon runtime data (sessions, plugin store, …). Overridable for tests/deploys. */
export const OPERON_DATA_DIR = process.env.OPERON_DATA_DIR || path.join(os.homedir(), '.operon', 'data')

/** Home dir the agent-framework harness writes under (`<homeDir>/sessions`, `<homeDir>/plugins`). */
export const HARNESS_HOME_DIR = path.join(OPERON_DATA_DIR, 'operon-agents')
