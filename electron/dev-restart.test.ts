import { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onDevPreloadBuild, restartDevElectron } from './dev-restart'

const startup = vi.hoisted(() => Object.assign(vi.fn<() => Promise<void>>(), {
  exit: vi.fn<() => Promise<void>>(),
}))
vi.mock('vite-plugin-electron', () => ({ startup }))

const devProcess: NodeJS.Process & { electronApp?: ChildProcess } = process

describe('Electron dev restart', () => {
  beforeEach(() => {
    startup.mockReset().mockResolvedValue(undefined)
    startup.exit.mockReset().mockImplementation(async () => {
      devProcess.electronApp?.removeAllListeners()
    })
  })

  afterEach(() => {
    delete devProcess.electronApp
    vi.useRealTimers()
  })

  it('coalesces rebuilds and waits for the old main process to exit', async () => {
    const child = Object.assign(new ChildProcess(), { pid: 42 })
    devProcess.electronApp = child
    const reload = vi.fn()
    const restarting = restartDevElectron()

    expect(restartDevElectron()).toBe(restarting)
    expect(onDevPreloadBuild({ reload })).toBe(restarting)
    await Promise.resolve()
    expect(startup.exit).toHaveBeenCalledOnce()
    expect(startup).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()

    child.emit('exit', 0, null)
    await restarting
    expect(startup).toHaveBeenCalledOnce()
    expect(devProcess.electronApp).toBeUndefined()
  })

  it('waits for exit even when the old process needs a forced shutdown', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new ChildProcess(), { pid: 42 })
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true)
    devProcess.electronApp = child

    const restarting = restartDevElectron()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(startup).not.toHaveBeenCalled()

    child.emit('exit', null, 'SIGKILL')
    await restarting
    expect(startup).toHaveBeenCalledOnce()
  })

  it('can start from the preload build and reloads the renderer on later preload builds', async () => {
    const child = Object.assign(new ChildProcess(), { pid: 42 })
    startup.mockImplementation(async () => { devProcess.electronApp = child })
    const reload = vi.fn()

    await onDevPreloadBuild({ reload })
    expect(startup).toHaveBeenCalledOnce()
    expect(startup.exit).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()

    onDevPreloadBuild({ reload })
    expect(reload).toHaveBeenCalledOnce()
    expect(startup).toHaveBeenCalledOnce()
  })
})
