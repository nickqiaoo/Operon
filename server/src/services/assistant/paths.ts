import os from 'os'
import path from 'path'

/** The assistant's home: its definition files (identity / soul / memory / heartbeat). */
export const ASSISTANT_DIR = process.env.OPERON_ASSISTANT_DIR || path.join(os.homedir(), '.operon', 'assistant')

/** Where the assistant and its workers run tools. Not a repo — the assistant has none. */
export const ASSISTANT_WORKSPACE = path.join(ASSISTANT_DIR, 'workspace')

/**
 * Where the main agent's session runs. Apart from the workers' directory on purpose: OpenCode
 * registers MCP servers per directory, and the main agent must not be offered a worker's tools.
 */
export const ASSISTANT_CONVERSATION_DIR = path.join(ASSISTANT_DIR, 'conversation')

/** Where the wrap-up of a finished stretch of conversation runs (see runtime.ts). */
export const ASSISTANT_WRAPUP_DIR = path.join(ASSISTANT_DIR, 'wrap-up')
