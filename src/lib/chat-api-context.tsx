import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { api as localApi, apiFor, type Api } from '@/lib/api'
import { localTransport, transportFor, type ApiTransport } from '@/lib/api-client'
import { chatRefOf, nodeKeyOf, type ChatRef, type NodeKey } from '@/lib/chat-ref'

/**
 * The backend one chat tab talks to. A tab's conversation lives on exactly one
 * machine; code inside the tab reads its API from here rather than importing
 * the global `api`, so a tab can show a chat stored on another machine of the
 * account while the tab next to it stays local.
 *
 * Why per tab and not a global switch: hidden tabs stay mounted with their
 * streams, polls and approvals running, so flipping one global base URL would
 * send local tabs' requests to the remote machine too.
 */
interface ChatBackend {
  nodeId: string | undefined
  api: Api
  transport: ApiTransport
}

const ChatApiContext = createContext<ChatBackend | null>(null)

/**
 * `apiFor` for code outside React (query functions, stores). This machine is the
 * global `api` itself, read at call time — so tests that mock `@/lib/api` with
 * only `api` keep working on every local path.
 */
export function apiOn(nodeId: string | undefined): Api {
  return nodeId ? apiFor(nodeId) : localApi
}

/**
 * A query key scoped to a machine: unchanged for this one, the machine id
 * appended for another. Appended rather than prefixed so every existing prefix
 * invalidation (`['git', root]`, `['fs']`…) still reaches both.
 */
export function onNode<K extends readonly unknown[]>(key: K, nodeId: string | undefined): K | readonly [...K, string] {
  return nodeId ? [...key, nodeId] as const : key
}

/** Binds everything below to the machine `nodeId` (undefined: this machine). */
export function ChatApiProvider({ nodeId, children }: { nodeId: string | undefined; children: ReactNode }) {
  const value = useMemo<ChatBackend>(
    () => (nodeId
      ? { nodeId, transport: transportFor(nodeId), api: apiOn(nodeId) }
      : { nodeId: undefined, transport: localTransport, api: localApi }),
    [nodeId],
  )
  return <ChatApiContext.Provider value={value}>{children}</ChatApiContext.Provider>
}

/**
 * Outside a provider this is this machine's backend. `localApi` is read at call
 * time, not captured at module load, so tests that `vi.mock('@/lib/api')` still
 * swap it out.
 */
function useChatBackend(): ChatBackend {
  return useContext(ChatApiContext) ?? { nodeId: undefined, api: localApi, transport: localTransport }
}

/** The API of the machine this tab's chat lives on. Stable for the tab's lifetime. */
export function useChatApi(): Api {
  return useChatBackend().api
}

/**
 * The transport itself, for requests the `api` table cannot make: the
 * `useChat` stream, raw SSE feeds, `<img src>` URLs.
 */
export function useChatTransport(): ApiTransport {
  return useChatBackend().transport
}

/** The machine this tab's chat lives on; undefined for this machine. */
export function useChatNodeId(): string | undefined {
  return useChatBackend().nodeId
}

/**
 * The machine segment for query keys of per-chat data: chat ids are only unique
 * per machine, so a remote chat 12 must not share a cache entry with local
 * chat 12. `'local'` for this machine.
 */
export function useChatNodeKey(): NodeKey {
  return nodeKeyOf(useChatBackend().nodeId)
}

/**
 * `chatId` as a ref on this tab's machine — for stores and keys indexed by
 * `ChatRef`. Memoized so it can be an effect dependency.
 */
export function useChatRef(chatId: number | null | undefined): ChatRef | undefined {
  const nodeId = useChatBackend().nodeId
  return useMemo(() => chatRefOf(chatId, nodeId), [chatId, nodeId])
}
