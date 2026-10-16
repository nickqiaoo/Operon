import os from 'os'
import path from 'path'

/**
 * The assistant's home: its definition files (identity / soul / memory) and day notes, plain files
 * the main agent and its workers read and edit with their own file tools. The main agent's session
 * runs here.
 */
export const ASSISTANT_DIR = process.env.OPERON_ASSISTANT_DIR || path.join(os.homedir(), '.operon', 'assistant')

/** One note per local day (`days/2026-10-12.md`): the details too specific for memory.md. */
export const DAYS_DIR = path.join(ASSISTANT_DIR, 'days')

/** Where the assistant and its workers run tools. Not a repo — the assistant has none. */
export const ASSISTANT_WORKSPACE = path.join(ASSISTANT_DIR, 'workspace')

/**
 * What the assistant made for the user — the plan, report or document a task was for. The Files tab
 * shows this folder and nothing else: the code, downloads and scratch files of getting there stay in
 * the rest of the workspace, out of sight.
 */
export const ASSISTANT_OUTPUTS = path.join(ASSISTANT_WORKSPACE, 'outputs')

/**
 * Where the wrap-up of a finished stretch of conversation runs (see runtime.ts). Every kind of
 * session has a directory of its own on purpose: OpenCode registers MCP servers per directory, and
 * one session must not be offered another's tools. It edits ASSISTANT_DIR as a writable dir.
 */
export const ASSISTANT_WRAPUP_DIR = path.join(ASSISTANT_DIR, 'wrap-up')
