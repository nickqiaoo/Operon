import os from 'os'
import path from 'path'
import { OPERON_DATA_DIR } from '../operon-runtime/paths.js'

/** The assistant's home: its definition files (identity / soul / memory / heartbeat). */
export const ASSISTANT_DIR = process.env.OPERON_ASSISTANT_DIR || path.join(os.homedir(), '.operon', 'assistant')

/** Where the assistant and its workers run tools. Not a repo — the assistant has none. */
export const ASSISTANT_WORKSPACE = path.join(ASSISTANT_DIR, 'workspace')

/** Framework session store for the assistant, kept apart from the coding chats' harness. */
export const ASSISTANT_HARNESS_HOME = path.join(OPERON_DATA_DIR, 'assistant-agents')
