import { beforeEach, describe, expect, it, vi } from 'vitest'

const runOneShotPrompt = vi.fn<(options: { prompt: string }) => Promise<string>>()
vi.mock('./ai/one-shot.js', () => ({ runOneShotPrompt: (options: { prompt: string }) => runOneShotPrompt(options) }))
vi.mock('./commit-message-config.js', () => ({ getCommitMessageConfig: () => ({ providerId: '', modelId: '' }) }))
const broadcastTask = vi.fn()
vi.mock('./task-events.js', () => ({ broadcastTask: (...args: unknown[]) => broadcastTask(...args) }))

import type { Task } from '../types/task.js'
import {
  cleanGeneratedTitle,
  isTaskTitlePending,
  placeholderTaskTitle,
  startTaskTitleGeneration,
  waitForTaskTitle,
  type TaskTitleStorage,
} from './task-title.js'

/** One task in memory, with the same compare-and-set rule as the sqlite store. */
function storeWith(task: Pick<Task, 'id' | 'projectId' | 'title' | 'titleSource' | 'description'>) {
  const row = { ...task }
  const storage = {
    taskGet: (id: number) => (id === row.id ? ({ ...row } as Task) : null),
    getProject: () => ({ id: row.projectId, rootPath: '/repo' }),
    taskReplaceAutoTitle: vi.fn((id: number, placeholder: string, title: string) => {
      if (id !== row.id || row.titleSource !== 'auto' || row.title !== placeholder) return false
      row.title = title
      return true
    }),
  } as unknown as TaskTitleStorage
  /** A person renaming it, as `taskUpdate` does. */
  const rename = (title: string) => Object.assign(row, { title, titleSource: 'user' as const })
  return { storage, row, rename }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

describe('placeholder title', () => {
  it('is the first line with text, as plain text', () => {
    expect(placeholderTaskTitle('\n\n## Add a **dark** mode toggle\nmore')).toBe('Add a dark mode toggle')
    expect(placeholderTaskTitle('- [ ] fix [the link](https://x.y) in `README`')).toBe('fix the link in README')
    expect(placeholderTaskTitle('```ts\nconst a = 1\n```\n> 修复登录页白屏')).toBe('修复登录页白屏')
  })

  it('is cut to 60 characters', () => {
    const title = placeholderTaskTitle('word '.repeat(40))
    expect(Array.from(title).length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back when nothing in it reads as text', () => {
    expect(placeholderTaskTitle('---\n\n')).toBe('Untitled task')
  })
})

describe('generated title cleanup', () => {
  it('keeps one line, without quotes, prefixes or a trailing period', () => {
    expect(cleanGeneratedTitle('"Add dark mode toggle."\n\nBecause…')).toBe('Add dark mode toggle')
    expect(cleanGeneratedTitle('Title: Fix login crash')).toBe('Fix login crash')
    expect(cleanGeneratedTitle('```\n「修复登录页白屏」\n```')).toBe('修复登录页白屏')
    expect(Array.from(cleanGeneratedTitle('x'.repeat(200))).length).toBe(60)
  })
})

describe('generating a blank title', () => {
  beforeEach(() => {
    runOneShotPrompt.mockReset()
    broadcastTask.mockReset()
  })

  it('swaps the generated title in for the placeholder', async () => {
    const { storage, row } = storeWith({ id: 1, projectId: 2, title: 'fix the login page', titleSource: 'auto', description: 'fix the login page' })
    runOneShotPrompt.mockResolvedValue('Fix login page crash')

    const run = startTaskTitleGeneration(storage, 1)
    expect(isTaskTitlePending(1)).toBe(true)
    await run

    expect(row.title).toBe('Fix login page crash')
    expect(isTaskTitlePending(1)).toBe(false)
    expect(broadcastTask).toHaveBeenCalledWith(storage, 1)
    expect(runOneShotPrompt.mock.calls[0][0].prompt).toContain('fix the login page')
  })

  it('drops the generated title when the person renamed the task meanwhile', async () => {
    const { storage, row, rename } = storeWith({ id: 3, projectId: 2, title: 'placeholder', titleSource: 'auto', description: 'placeholder' })
    const answer = deferred<string>()
    runOneShotPrompt.mockReturnValue(answer.promise)

    const run = startTaskTitleGeneration(storage, 3)
    rename('My own title')
    answer.resolve('Generated title')
    await run

    expect(row.title).toBe('My own title')
    expect(isTaskTitlePending(3)).toBe(false)
  })

  it('keeps the placeholder when the model fails, without throwing', async () => {
    const { storage, row } = storeWith({ id: 4, projectId: 2, title: 'placeholder', titleSource: 'auto', description: 'placeholder' })
    runOneShotPrompt.mockRejectedValue(new Error('no provider configured'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(startTaskTitleGeneration(storage, 4)).resolves.toBeUndefined()

    expect(row.title).toBe('placeholder')
    expect(isTaskTitlePending(4)).toBe(false)
    // The "generating" state still clears on the board.
    expect(broadcastTask).toHaveBeenCalledWith(storage, 4)
  })

  it('does nothing for a task whose title a person wrote', async () => {
    const { storage } = storeWith({ id: 5, projectId: 2, title: 'Mine', titleSource: 'user', description: 'x' })
    await startTaskTitleGeneration(storage, 5)
    expect(runOneShotPrompt).not.toHaveBeenCalled()
  })

  it('lets dispatch wait for the title, but not past the timeout', async () => {
    const { storage, row } = storeWith({ id: 6, projectId: 2, title: 'placeholder', titleSource: 'auto', description: 'placeholder' })
    const answer = deferred<string>()
    runOneShotPrompt.mockReturnValue(answer.promise)
    const run = startTaskTitleGeneration(storage, 6)

    await waitForTaskTitle(6, 20)
    expect(row.title).toBe('placeholder')

    const waiting = waitForTaskTitle(6, 5_000)
    answer.resolve('Generated')
    await waiting
    expect(row.title).toBe('Generated')
    await run
    await expect(waitForTaskTitle(6, 5_000)).resolves.toBeUndefined()
  })
})
