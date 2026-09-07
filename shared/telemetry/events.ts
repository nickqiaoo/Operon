/**
 * operon's product telemetry registry — the single place that says what the app counts.
 *
 * Every event is declared once with a description for every property. Two type-level devices
 * keep it from rotting (the same ones operon-agents uses for its framework registry):
 *
 *  - `properties: { [K in keyof P]-?: string }` — a property without a description does not
 *    compile.
 *  - `Exact<Expected, Actual>` on the track functions — an extra property at a call site does
 *    not compile. Structural typing would otherwise let "one more field" through, and that is
 *    how user data ends up in analytics.
 *
 * This file is imported by the renderer (posthog-js), the server (through the framework's
 * `TelemetryService.withRegistry`) and the main process, so it depends on nothing. The helper
 * types mirror `operon-agents-core/telemetry` structurally — `withRegistry` accepts them as-is.
 *
 * Red lines: properties are counts, durations, enums and ids we own. Never prompts, file
 * contents, paths, URLs or model output. Identity (`distinct_id`) and consent live in
 * `src/lib/analytics.ts` / `electron/analytics.ts`, never here.
 *
 * Agent-level events for the operon provider (turn / tool / compaction / sub-agent …) are NOT
 * declared here: the framework projects them from its own event stream
 * (`FRAMEWORK_TELEMETRY_EVENTS`). `agent_turn_finished` below stays because it covers every
 * provider — claude-code, codex, gemini … — which the framework projection cannot see.
 */

export type TelemetryPrimitive = string | number | boolean | null

export type TelemetryProperties = Record<string, TelemetryPrimitive | undefined>

export interface TelemetryEventDefinition<P extends TelemetryProperties = TelemetryProperties> {
  readonly owner: string
  readonly comment: string
  readonly scope: 'session' | 'global'
  readonly properties: { readonly [K in keyof P]-?: string }
  /** Phantom carrier for the payload type; never set at runtime. */
  readonly payload?: P
}

function defineEvent<P extends TelemetryProperties>(spec: {
  readonly comment: string
  readonly properties: { readonly [K in keyof P]-?: string }
}): TelemetryEventDefinition<P> {
  return { owner: 'operon', scope: 'global', ...spec }
}

export type PayloadOf<D> = D extends TelemetryEventDefinition<infer P> ? P : never

/** `Actual` must fit `Expected` and carry no key `Expected` lacks; otherwise `never`. */
export type Exact<Expected, Actual> = Actual extends Expected
  ? Exclude<keyof Actual, keyof Expected> extends never
    ? Actual
    : never
  : never

// ── Renderer: app shell ───────────────────────────────────────────────────────────────────────

type AppOpened = {
  /** `navigator.platform`: coarse OS family, not a device id. */
  platform: string
}

type PageOpened = { page: 'settings' | 'cronjob' | 'skill' | 'canvas' | 'inbox' }
type PageClosed = { page: 'settings' | 'skill' }

type ProjectAdded = { workspace_count: number }
type WorkspaceSwitched = Record<never, never>

type ChatCreated = { provider_id: string }
type TerminalCreated = { provider_id: string }
type DiffOpened = {
  /** File extension only, never the path. */
  extension: string | undefined
}

// ── Renderer: the work signals ────────────────────────────────────────────────────────────────

type MessageSent = {
  provider_id: string
  model: string | undefined
  has_attachments: boolean
}

type AgentTurnFinished = {
  outcome: 'completed' | 'disconnected' | 'error' | 'stopped'
  /** Undefined when the tab had no provider bound yet. */
  provider_id: string | undefined
  duration_ms: number
}

type ChangesCommitted = {
  pushed: boolean
  include_unstaged: boolean
}

type ChangesRewound = {
  forced: boolean
  files_changed: number
}

type TaskStatusSettled = {
  status: string
  from: string | undefined
}

// ── Server: LLM prompt-cache monitor ──────────────────────────────────────────────────────────

type LlmCacheBreak = {
  conversation_id: string
  provider_id: string
  model: string | undefined
  call_seq: number
  cache_read_tokens: number
  prev_cache_read_tokens: number
  cache_write_tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_ratio: number
  seconds_since_prev_call: number
}

type LlmCall = {
  conversation_id: string
  provider_id: string
  model: string | undefined
  call_seq: number
  cache_read_tokens: number
  cache_write_tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_ratio: number
  seconds_since_prev_call: number | null
  suspected_cache_break: boolean
}

export const PRODUCT_TELEMETRY_EVENTS = {
  app_opened: defineEvent<AppOpened>({
    comment: 'The renderer booted.',
    properties: { platform: 'navigator.platform — OS family only' },
  }),
  page_opened: defineEvent<PageOpened>({
    comment: 'A full-screen page was opened from the shell.',
    properties: { page: 'Which page: settings, cronjob, skill, canvas, inbox' },
  }),
  page_closed: defineEvent<PageClosed>({
    comment: 'A full-screen page was closed via its back action.',
    properties: { page: 'Which page: settings, skill' },
  }),
  project_added: defineEvent<ProjectAdded>({
    comment: 'A workspace was added to the project list.',
    properties: { workspace_count: 'Total workspaces after the add' },
  }),
  workspace_switched: defineEvent<WorkspaceSwitched>({
    comment: 'The active workspace changed.',
    properties: {},
  }),
  chat_created: defineEvent<ChatCreated>({
    comment: 'A new chat tab was created.',
    properties: { provider_id: 'Provider the chat was created for' },
  }),
  terminal_created: defineEvent<TerminalCreated>({
    comment: 'A new terminal tab was created.',
    properties: { provider_id: 'Provider active when the terminal was created' },
  }),
  diff_opened: defineEvent<DiffOpened>({
    comment: 'A file diff was opened from the changes list.',
    properties: { extension: 'File extension (after the last dot), never the path; undefined when none' },
  }),
  message_sent: defineEvent<MessageSent>({
    comment: 'The user sent a chat message.',
    properties: {
      provider_id: 'Provider the message went to',
      model: 'Model id chosen for the message, or undefined for the provider default',
      has_attachments: 'Whether files or images were attached',
    },
  }),
  agent_turn_finished: defineEvent<AgentTurnFinished>({
    comment: 'A chat turn ended, for any provider. The framework emits richer turn_finished for the operon provider.',
    properties: {
      outcome: 'completed, disconnected, error or stopped',
      provider_id: 'Provider that ran the turn, or undefined when the tab had none bound',
      duration_ms: 'Wall-clock from send to finish, renderer-side',
    },
  }),
  changes_committed: defineEvent<ChangesCommitted>({
    comment: 'The user committed agent changes — the strongest "the work was good" signal.',
    properties: {
      pushed: 'Whether the commit was also pushed',
      include_unstaged: 'Whether unstaged changes were included',
    },
  }),
  changes_rewound: defineEvent<ChangesRewound>({
    comment: 'The user rewound the workspace to a checkpoint — the "the work was not good" signal.',
    properties: {
      forced: 'Whether the rewind discarded uncommitted work',
      files_changed: 'Files touched by the rewind',
    },
  }),
  task_status_settled: defineEvent<TaskStatusSettled>({
    comment: 'A task reached a terminal status (done or cancelled).',
    properties: {
      status: 'Terminal status reached',
      from: 'Status before the change, or undefined when unknown',
    },
  }),
  llm_cache_break: defineEvent<LlmCacheBreak>({
    comment: 'Prompt cache reads collapsed between two close calls in one conversation — the fingerprint of a cache-busting regression. Zero per healthy build.',
    properties: {
      conversation_id: 'Conversation the calls belong to (app-owned id)',
      provider_id: 'Provider that made the call',
      model: 'Model id, or undefined when the provider did not say',
      call_seq: 'Index of this call within the conversation',
      cache_read_tokens: 'Cache-read tokens on this call',
      prev_cache_read_tokens: 'Cache-read tokens on the previous call',
      cache_write_tokens: 'Cache-write tokens on this call',
      input_tokens: 'Prompt tokens on this call',
      output_tokens: 'Completion tokens on this call',
      cache_read_ratio: 'cache_read / total prompt, 0..1',
      seconds_since_prev_call: 'Gap to the previous call, rounded',
    },
  }),
  llm_call: defineEvent<LlmCall>({
    comment: 'One LLM call sample. Off by default (EMIT_ALL_SAMPLES); high volume.',
    properties: {
      conversation_id: 'Conversation the call belongs to (app-owned id)',
      provider_id: 'Provider that made the call',
      model: 'Model id, or undefined when the provider did not say',
      call_seq: 'Index of this call within the conversation',
      cache_read_tokens: 'Cache-read tokens',
      cache_write_tokens: 'Cache-write tokens',
      input_tokens: 'Prompt tokens',
      output_tokens: 'Completion tokens',
      cache_read_ratio: 'cache_read / total prompt, 0..1',
      seconds_since_prev_call: 'Gap to the previous call, or null on the first',
      suspected_cache_break: 'Whether this call tripped the cache-break detector',
    },
  }),
} as const

export type ProductTelemetryEvents = typeof PRODUCT_TELEMETRY_EVENTS
export type ProductTelemetryEventName = keyof ProductTelemetryEvents
export type ProductTelemetryPayload<K extends ProductTelemetryEventName> = PayloadOf<ProductTelemetryEvents[K]>
