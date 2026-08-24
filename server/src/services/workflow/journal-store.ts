/**
 * SessionStore shim backing the framework's resume journal with the run's own
 * event log.
 *
 * `WorkflowJournal` persists through a `SessionStore`'s append log and only ever
 * calls `appendRecord` + `readRecords`. This implements exactly those two over
 * `journal` events, so the framework journal runs UNCHANGED while its records
 * land in the same append-only log as everything else about the run — one table,
 * one retention rule, one thing to delete when a run is pruned.
 *
 * (It previously had a table of its own, which meant a run's history lived in
 * two places, with two lifetimes and no code deleting either.)
 *
 * The log is reached through a small injected port rather than the store module
 * directly, so the resume path is testable with an in-memory fake and never
 * hard-depends on app storage being initialised. The three KV-state methods the
 * interface requires are stubbed: the journal never touches them.
 */

import type {
  AgentRecord,
  ReadRecordPageOptions,
  ReadRecordsFilter,
  RecordPage,
  SessionStore,
  StateKey,
} from 'operon-agents'
import { appendEvent, readRunEvents } from './store.js'

/** The two journal operations the shim needs, over whatever holds the log. */
export interface WorkflowJournalPort {
  append(runId: string, addr: string, record: unknown): void
  read(runId: string): { addr: string; record: unknown }[]
}

/** The real port: journal events in the run's log. */
export const eventLogJournalPort: WorkflowJournalPort = {
  append: (runId, addr, record) => appendEvent(runId, { kind: 'journal', addr, record }),
  read: (runId) =>
    readRunEvents(runId).flatMap((stored) =>
      stored.event.kind === 'journal' ? [{ addr: stored.event.addr, record: stored.event.record }] : [],
    ),
}

export function workflowJournalStore(
  runId: string,
  port: WorkflowJournalPort = eventLogJournalPort,
): SessionStore {
  return {
    async appendRecord(record: AgentRecord): Promise<string> {
      const addr = record.address ?? 'main'
      port.append(runId, addr, record)
      // The store owes the caller a sequence. The log is append-only, so a record's
      // position in it never changes — its index IS a stable sequence. Counted from
      // the log itself rather than a local counter, so a resumed run (whose events
      // were written by an earlier process) keeps numbering where it left off.
      return String(port.read(runId).length - 1)
    },
    async *readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
      for (const row of port.read(runId)) {
        if (filter?.address !== undefined && row.addr !== filter.address) continue
        yield row.record as AgentRecord
      }
    },
    // Not used by WorkflowJournal (it replays whole shards), but part of the interface
    // — implemented over the same indices so any generic reader sees one consistent log.
    async readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage> {
      const rows = port
        .read(runId)
        .map((row, sequence) => ({ sequence: String(sequence), record: row.record as AgentRecord, addr: row.addr }))
        .filter((row) => options.address === undefined || row.addr === options.address)
      const desc = options.order === 'desc'
      if (desc) rows.reverse()
      const start =
        options.after === undefined
          ? 0
          : rows.findIndex((row) => row.sequence === options.after) + 1
      const page = rows.slice(start, start + options.limit)
      const data = page.map(({ sequence, record }) => ({ sequence, record }))
      const next = start + options.limit < rows.length ? data[data.length - 1]?.sequence : undefined
      return next === undefined ? { data } : { data, next }
    },
    // Unused by WorkflowJournal — stubbed to satisfy the SessionStore interface.
    async putState(_key: StateKey, _value: unknown): Promise<void> {},
    async getState(_key: StateKey): Promise<unknown | null> {
      return null
    },
    async deleteState(_key: StateKey): Promise<void> {},
  }
}
