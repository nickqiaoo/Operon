import os from 'os'
import path from 'path'

/** Root for all operon runtime data (sessions, plugin store, …). Overridable for tests/deploys. */
export const OPERON_DATA_DIR = process.env.OPERON_DATA_DIR || path.join(os.homedir(), '.operon', 'data')

/** Home dir the agent-framework harness writes under (`<homeDir>/sessions`, `<homeDir>/plugins`). */
export const HARNESS_HOME_DIR = path.join(OPERON_DATA_DIR, 'operon-agents')

/**
 * File extensions (`harness.extensions`): one folder per extension under here, each holding a
 * `manifest.json` + bundle. Loading one is the user's approval — nothing here auto-runs.
 */
export const EXTENSIONS_DIR = path.join(OPERON_DATA_DIR, 'extensions')

/** Teams settings (budget / teammate types) edited from Settings → Extensions → Teams. Roster
 *  cards and the mailbox ledger live in the extension's own data dir (`<EXTENSIONS_DIR>/.data/peers`). */
export const PEERS_CONFIG_PATH = path.join(OPERON_DATA_DIR, 'peers.json')
