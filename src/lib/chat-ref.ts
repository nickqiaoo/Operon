/**
 * Which conversation, on which machine.
 *
 * A chat is stored on exactly one machine of the account, and chat ids are only
 * unique per machine: a remote chat 12 and this machine's chat 12 are different
 * conversations. Anything that remembers chats across tabs (stores, query keys,
 * tab ids) must therefore key on the pair, never on the bare number.
 *
 * `nodeId` is absent for this machine's own chats, which keeps every existing
 * local ref (`{ chatId }`) and every key derived from it unchanged.
 */
export interface ChatRef {
  /** The machine the chat lives on; undefined for this machine. */
  readonly nodeId?: string
  readonly chatId: number
}

/**
 * A `ChatRef` flattened for use as a Map / Record key. Branded so a bare
 * `String(chatId)` can't be passed where a key is expected — build it with
 * `chatKey()`.
 */
export type ChatKey = string & { readonly __chatKey: unique symbol }

/** Machine segment of a key: `'local'` for this machine. */
export type NodeKey = string

export const LOCAL_NODE: NodeKey = 'local'

export function nodeKeyOf(nodeId: string | undefined): NodeKey {
  return nodeId ?? LOCAL_NODE
}

/** `"12"` for a local chat (same as before refs existed), `"<nodeId>:12"` for a remote one. */
export function chatKey(ref: ChatRef): ChatKey {
  return (ref.nodeId ? `${ref.nodeId}:${ref.chatId}` : String(ref.chatId)) as ChatKey
}

export function localChat(chatId: number): ChatRef {
  return { chatId }
}

/** A ref for `chatId` on `nodeId`'s machine, or `undefined` when there is no chat yet. */
export function chatRefOf(chatId: number | null | undefined, nodeId?: string): ChatRef | undefined {
  if (chatId == null) return undefined
  return nodeId ? { nodeId, chatId } : { chatId }
}

export function sameChat(a: ChatRef | null | undefined, b: ChatRef | null | undefined): boolean {
  if (a == null || b == null) return false
  return a.chatId === b.chatId && (a.nodeId ?? undefined) === (b.nodeId ?? undefined)
}

/** The machine segment of a key (`'local'` for this machine). */
export function chatKeyNode(key: ChatKey): NodeKey {
  const at = key.lastIndexOf(':')
  return at < 0 ? LOCAL_NODE : key.slice(0, at)
}

export function chatKeyId(key: ChatKey): number {
  return Number(key.slice(key.lastIndexOf(':') + 1))
}

/** `nodeKeyOf` inverse: the `nodeId` a ref on that machine carries. */
export function nodeIdOf(node: NodeKey): string | undefined {
  return node === LOCAL_NODE ? undefined : node
}

/**
 * One machine's entries of a chat-keyed map, by bare chat id — for code that
 * only ever deals with one machine's chats (the sidebar lists this machine's).
 */
export function nodeEntries<V>(map: ReadonlyMap<ChatKey, V>, node: NodeKey): Map<number, V> {
  const out = new Map<number, V>()
  for (const [key, value] of map) if (chatKeyNode(key) === node) out.set(chatKeyId(key), value)
  return out
}

/** Same as `nodeEntries` for a set. */
export function nodeChatIds(set: ReadonlySet<ChatKey>, node: NodeKey): Set<number> {
  const out = new Set<number>()
  for (const key of set) if (chatKeyNode(key) === node) out.add(chatKeyId(key))
  return out
}

/**
 * `map` with `node`'s entries replaced by `entries` — what a machine's `sync`
 * frame means. Other machines' entries are untouched.
 */
export function replaceNodeEntries<V>(
  map: ReadonlyMap<ChatKey, V>,
  node: NodeKey,
  entries: Iterable<[number, V]>,
): Map<ChatKey, V> {
  const out = new Map<ChatKey, V>()
  for (const [key, value] of map) if (chatKeyNode(key) !== node) out.set(key, value)
  const nodeId = nodeIdOf(node)
  for (const [chatId, value] of entries) out.set(chatKey({ nodeId, chatId }), value)
  return out
}

/**
 * The editor tab id for a persisted chat: `chat:12` for this machine (the form
 * every existing opener builds), `chat:<nodeId>:12` for another machine.
 */
export function chatTabId(ref: ChatRef): string {
  return ref.nodeId ? `chat:${ref.nodeId}:${ref.chatId}` : `chat:${ref.chatId}`
}

/** `chatTabId` inverse; undefined for a draft's `chat:<uuid>` and non-chat tabs. */
export function chatRefFromTabId(tabId: string): ChatRef | undefined {
  const match = /^chat:(?:(.+):)?(\d+)$/.exec(tabId)
  if (!match) return undefined
  const chatId = Number.parseInt(match[2], 10)
  if (!(chatId > 0)) return undefined
  return match[1] ? { nodeId: match[1], chatId } : { chatId }
}

/** The persisted chat a tab shows, once it has one. */
export function chatRefOfTab(tab: { chatId?: number; nodeId?: string }): ChatRef | undefined {
  return chatRefOf(tab.chatId, tab.nodeId)
}

/**
 * Which workspace, on which machine. Workspace (and project) ids are only unique
 * per machine, like chat ids.
 */
export interface WorkspaceRef {
  readonly nodeId?: string
  readonly workspaceId: number
}

/**
 * The key a workspace's buckets (editor tabs, panel tabs, panel open state) are
 * stored under: `"global"` for no workspace, `"3"` for this machine's workspace
 * 3 (as before machines existed), `"<nodeId>:3"` for another machine's.
 */
/**
 * Whether two machine ids name the same machine. Undefined and null both mean
 * this one — stores hold `undefined`, `editor-store.currentNodeId` holds `null`.
 */
export function sameNode(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null)
}

export function workspaceBucketKey(workspaceId: number | null | undefined, nodeId?: string | null): string {
  if (workspaceId == null) return 'global'
  return nodeId ? `${nodeId}:${workspaceId}` : String(workspaceId)
}

/** `workspaceBucketKey` inverse. */
export function parseWorkspaceBucketKey(key: string): { workspaceId: number | null; nodeId?: string } {
  if (key === 'global') return { workspaceId: null }
  const at = key.lastIndexOf(':')
  if (at < 0) return { workspaceId: Number(key) }
  return { nodeId: key.slice(0, at), workspaceId: Number(key.slice(at + 1)) }
}
