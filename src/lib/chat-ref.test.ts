import { describe, expect, it } from 'vitest'
import {
  LOCAL_NODE,
  chatKey,
  chatKeyId,
  chatKeyNode,
  chatRefFromTabId,
  chatRefOf,
  chatRefOfTab,
  chatTabId,
  nodeChatIds,
  nodeEntries,
  nodeIdOf,
  nodeKeyOf,
  parseWorkspaceBucketKey,
  replaceNodeEntries,
  sameChat,
  sameNode,
  workspaceBucketKey,
  type ChatKey,
} from './chat-ref'

const NODE = 'node-b2f1'

describe('chat keys', () => {
  it('keeps the bare chat id for this machine and prefixes another machine', () => {
    expect(chatKey({ chatId: 12 })).toBe('12')
    expect(chatKey({ nodeId: NODE, chatId: 12 })).toBe(`${NODE}:12`)
  })

  it('splits a key back into its machine and chat id', () => {
    const local = chatKey({ chatId: 7 })
    const remote = chatKey({ nodeId: NODE, chatId: 7 })
    expect([chatKeyNode(local), chatKeyId(local)]).toEqual([LOCAL_NODE, 7])
    expect([chatKeyNode(remote), chatKeyId(remote)]).toEqual([NODE, 7])
  })

  it('reads a node id that itself contains a colon', () => {
    const key = chatKey({ nodeId: 'a:b', chatId: 3 })
    expect(chatKeyNode(key)).toBe('a:b')
    expect(chatKeyId(key)).toBe(3)
  })

  it('maps node keys and node ids both ways', () => {
    expect(nodeKeyOf(undefined)).toBe(LOCAL_NODE)
    expect(nodeKeyOf(NODE)).toBe(NODE)
    expect(nodeIdOf(LOCAL_NODE)).toBeUndefined()
    expect(nodeIdOf(NODE)).toBe(NODE)
  })
})

describe('chat refs', () => {
  it('builds no ref before there is a chat', () => {
    expect(chatRefOf(null)).toBeUndefined()
    expect(chatRefOf(undefined, NODE)).toBeUndefined()
    expect(chatRefOf(4)).toEqual({ chatId: 4 })
    expect(chatRefOf(4, NODE)).toEqual({ nodeId: NODE, chatId: 4 })
    expect(chatRefOfTab({ chatId: 4, nodeId: NODE })).toEqual({ nodeId: NODE, chatId: 4 })
  })

  it('tells the same chat id on two machines apart', () => {
    expect(sameChat({ chatId: 5 }, { chatId: 5 })).toBe(true)
    expect(sameChat({ chatId: 5 }, { nodeId: NODE, chatId: 5 })).toBe(false)
    expect(sameChat({ nodeId: NODE, chatId: 5 }, { nodeId: NODE, chatId: 5 })).toBe(true)
    expect(sameChat(null, { chatId: 5 })).toBe(false)
  })

  it('treats null and undefined as this machine', () => {
    expect(sameNode(null, undefined)).toBe(true)
    expect(sameNode(NODE, NODE)).toBe(true)
    expect(sameNode(NODE, null)).toBe(false)
  })
})

describe('tab ids', () => {
  it('round-trips this machine and another machine', () => {
    expect(chatTabId({ chatId: 12 })).toBe('chat:12')
    expect(chatTabId({ nodeId: NODE, chatId: 12 })).toBe(`chat:${NODE}:12`)
    expect(chatRefFromTabId('chat:12')).toEqual({ chatId: 12 })
    expect(chatRefFromTabId(`chat:${NODE}:12`)).toEqual({ nodeId: NODE, chatId: 12 })
  })

  it('reads no chat from drafts and other tabs', () => {
    expect(chatRefFromTabId('chat:3f2a9c1e-7b6d-4e1a-9c2b-1a2b3c4d5e6f')).toBeUndefined()
    expect(chatRefFromTabId('chat:0')).toBeUndefined()
    expect(chatRefFromTabId('file:/tmp/a.ts')).toBeUndefined()
  })
})

describe('workspace bucket keys', () => {
  it('round-trips global, this machine and another machine', () => {
    for (const [workspaceId, nodeId, key] of [
      [null, undefined, 'global'],
      [3, undefined, '3'],
      [3, NODE, `${NODE}:3`],
    ] as const) {
      expect(workspaceBucketKey(workspaceId, nodeId)).toBe(key)
      expect(parseWorkspaceBucketKey(key)).toEqual(nodeId ? { workspaceId, nodeId } : { workspaceId })
    }
  })

  it('ignores the machine when there is no workspace', () => {
    expect(workspaceBucketKey(null, NODE)).toBe('global')
    expect(workspaceBucketKey(3, null)).toBe('3')
  })
})

describe('per-machine maps', () => {
  const map = new Map<ChatKey, string>([
    [chatKey({ chatId: 1 }), 'local 1'],
    [chatKey({ chatId: 2 }), 'local 2'],
    [chatKey({ nodeId: NODE, chatId: 1 }), 'remote 1'],
  ])

  it('reads one machine by bare chat id', () => {
    expect(nodeEntries(map, LOCAL_NODE)).toEqual(new Map([[1, 'local 1'], [2, 'local 2']]))
    expect(nodeEntries(map, NODE)).toEqual(new Map([[1, 'remote 1']]))
    expect(nodeChatIds(new Set(map.keys()), NODE)).toEqual(new Set([1]))
  })

  it("replaces one machine's entries and keeps the other's", () => {
    const next = replaceNodeEntries(map, NODE, [[9, 'remote 9']])
    expect([...next]).toEqual([
      ['1', 'local 1'],
      ['2', 'local 2'],
      [`${NODE}:9`, 'remote 9'],
    ])
    const cleared = replaceNodeEntries(map, LOCAL_NODE, [])
    expect([...cleared.keys()]).toEqual([`${NODE}:1`])
  })
})
