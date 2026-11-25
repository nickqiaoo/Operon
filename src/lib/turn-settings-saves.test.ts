import { describe, expect, it } from 'vitest'
import { trackTurnSettingsSave, turnSettingsSaved } from './turn-settings-saves'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const settled = async (promise: Promise<unknown>) => {
  let done = false
  void promise.then(() => { done = true })
  await new Promise((r) => setTimeout(r, 0))
  return done
}

describe('turn settings saves', () => {
  it('lets a send through at once when nothing is being saved', async () => {
    expect(await settled(turnSettingsSaved({ chatId: 1 }))).toBe(true)
  })

  it('holds a send until every save of that chat is answered', async () => {
    const mode = deferred()
    const model = deferred()
    void trackTurnSettingsSave({ chatId: 2 }, mode.promise)
    void trackTurnSettingsSave({ chatId: 2 }, model.promise)
    const wait = turnSettingsSaved({ chatId: 2 })

    mode.resolve()
    expect(await settled(wait)).toBe(false)
    model.resolve()
    expect(await settled(wait)).toBe(true)
  })

  it('does not hold a send back for a failed save', async () => {
    const save = deferred()
    void trackTurnSettingsSave({ chatId: 3 }, save.promise).catch(() => {})
    const wait = turnSettingsSaved({ chatId: 3 })
    save.reject(new Error('offline'))
    expect(await settled(wait)).toBe(true)
  })

  it('keeps chats apart, including the same id on another machine', async () => {
    const save = deferred()
    void trackTurnSettingsSave({ nodeId: 'node-b', chatId: 4 }, save.promise)
    expect(await settled(turnSettingsSaved({ chatId: 4 }))).toBe(true)
    expect(await settled(turnSettingsSaved({ nodeId: 'node-b', chatId: 4 }))).toBe(false)
    save.resolve()
  })
})
