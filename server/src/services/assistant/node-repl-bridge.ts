/**
 * How the assistant's workers reach node_repl (browser, Chrome, Computer Use, site adapters)
 * without a chat id. Imported by both the node_repl route and the assistant runtime, so it
 * depends on neither.
 *
 * The assistant's session mounts node_repl once, without a session id but with a per-process
 * key in the URL. Each worker's call names the worker in a hidden argument (added by the
 * assistant's tool wrapper, stripped by the route before any tool sees it), and the route gives
 * each worker its own vm context in the shared kernel — the same isolation a conversation gets,
 * keyed `assistant:<workerId>`. The argument counts only on a request that carries the key.
 */
import { randomBytes, timingSafeEqual } from 'crypto'
import type { HostElicitationRequest, HostElicitationResult } from '../ai/host-approval-broker.js'

/** Session-key prefix for an assistant worker's node_repl context. */
export const ASSISTANT_NODE_REPL_PREFIX = 'assistant:'

/** Hidden tool argument naming the calling worker. */
export const ASSISTANT_CALLER_ARG = '__operon_assistant_worker'

/**
 * Query parameter on the assistant's own node_repl mount. Every MCP client posts to the same
 * endpoint and a model writes its own tool arguments, so the hidden argument alone would let a
 * coding chat's model claim to be a worker and borrow the assistant's grants. Only a request
 * on the URL carrying this process's key is believed.
 */
export const ASSISTANT_KEY_PARAM = 'assistantKey'
const ASSISTANT_KEY = randomBytes(24).toString('hex')

/** `assistantKey=…` for the URL the assistant mounts node_repl with. */
export function assistantNodeReplQuery(): string {
  return `${ASSISTANT_KEY_PARAM}=${ASSISTANT_KEY}`
}

/** Whether a request's key is this process's — i.e. it came through the assistant's mount. */
export function isAssistantMountKey(value: string | undefined): boolean {
  if (!value) return false
  const given = Buffer.from(value)
  const expected = Buffer.from(ASSISTANT_KEY)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type AssistantElicitationHandler = (
  workerId: string,
  request: HostElicitationRequest,
) => Promise<HostElicitationResult>

let handler: AssistantElicitationHandler | undefined

/** The assistant runtime answers its workers' permission prompts (approval cards). */
export function setAssistantElicitationHandler(next: AssistantElicitationHandler | undefined): void {
  handler = next
}

/**
 * A worker's node_repl wants permission (a new site, an app). Without a live assistant there is
 * nobody to ask, so the answer is "not answered" — never the kernel's default of allowing.
 */
export function requestAssistantElicitation(workerId: string, request: HostElicitationRequest): Promise<HostElicitationResult> {
  return handler ? handler(workerId, request) : Promise.resolve({ action: 'cancel' })
}
