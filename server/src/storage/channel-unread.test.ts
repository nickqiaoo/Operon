import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { UNREAD_CAP } from '../types/channel.js'

const { SqliteStorage } = await import('./sqlite.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-channel-unread-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it.
let opened: InstanceType<typeof SqliteStorage> | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as InstanceType<typeof SqliteStorage>

let seq = 0
function setup() {
  seq += 1
  const project = storage.createProject({ name: `p${seq}`, rootPath: `/p${seq}` })
  const channel = storage.createChannel({ projectId: project.id, name: `general${seq}` })
  const agent = storage.createAgent({ name: `luna${seq}`, provider: 'codex', model: 'gpt' })
  const post = (senderType: 'human' | 'agent' | 'system', threadRootId: number | null = null) =>
    storage.createMessage({
      channelId: channel.id,
      threadRootId,
      senderType,
      senderId: senderType === 'agent' ? agent.id : null,
      senderName: senderType,
      content: 'x',
    })
  return { channel, post }
}

describe.skipIf(!opened)('channel unread for the person', () => {
  it('counts only agent messages in the main timeline, past the cursor', () => {
    const { channel, post } = setup()
    post('human')
    post('system')
    post('agent')
    post('agent')
    expect(storage.getChannelUnread(channel.id)).toEqual({ channelId: channel.id, unread: 2, threads: {} })

    storage.markChannelRead(channel.id)
    expect(storage.getChannelUnread(channel.id)?.unread).toBe(0)
    expect(storage.listChannelUnread().some((u) => u.channelId === channel.id)).toBe(false)
  })

  it('keeps thread replies out of the channel count and per thread instead', () => {
    const { channel, post } = setup()
    const root = post('human')
    post('agent', root.id)
    post('agent', root.id)
    post('human', root.id)
    const unread = storage.getChannelUnread(channel.id)
    expect(unread?.unread).toBe(0)
    expect(unread?.threads).toEqual({ [root.id]: 2 })
    expect(storage.listChannelUnread().find((u) => u.channelId === channel.id)?.threads).toEqual({ [root.id]: 2 })

    storage.markThreadRead(root.id)
    expect(storage.getChannelUnread(channel.id)?.threads).toEqual({})
  })

  it('never moves a cursor backwards', () => {
    const { channel, post } = setup()
    const first = post('agent')
    post('agent')
    storage.markChannelRead(channel.id)
    storage.markChannelRead(channel.id, first.id)
    expect(storage.getChannelUnread(channel.id)?.unread).toBe(0)
  })

  it('reads up to a given message', () => {
    const { channel, post } = setup()
    const first = post('agent')
    post('agent')
    storage.markChannelRead(channel.id, first.id)
    expect(storage.getChannelUnread(channel.id)?.unread).toBe(1)
  })

  it('stops counting at the cap', () => {
    const { channel, post } = setup()
    for (let i = 0; i < UNREAD_CAP + 5; i++) post('agent')
    expect(storage.getChannelUnread(channel.id)?.unread).toBe(UNREAD_CAP)
  })

  it('has no entry for a deleted channel', () => {
    const { channel } = setup()
    storage.deleteChannel(channel.id)
    expect(storage.getChannelUnread(channel.id)).toBeNull()
  })
})
