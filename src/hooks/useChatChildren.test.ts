import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { reach, activate, toast, openChatTab } = vi.hoisted(() => ({
  reach: { current: { unreachable: false } as { label?: string; online?: boolean; unreachable: boolean } },
  activate: vi.fn<(workspaceId: number, nodeId?: string) => Promise<boolean>>(),
  toast: vi.fn(),
  openChatTab: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/machine-reachability', () => ({ remoteMachineNow: () => reach.current }))
vi.mock('@/lib/workspace-nav', () => ({ activateWorkspace: activate }))
vi.mock('@/stores/editor-store', () => ({
  useEditorStore: { getState: () => ({ currentWorkspaceId: 1, currentNodeId: null, findChatTab: () => undefined, openChatTab }) },
}))
vi.mock('@/stores/chat-pending-input-store', () => ({ useChatPendingInputStore: vi.fn() }))
vi.mock('@/stores/external-agents-store', () => ({ useExternalAgentsStore: vi.fn(), isOnNode: vi.fn() }))
vi.mock('@/stores/project-store', () => ({ useProjectStore: vi.fn() }))

const { openChildChat, REMOTE_SWITCH_WAIT_MS } = await import('./useChatChildren')

const remoteChild = { childChatId: 6, nodeId: 'air', title: 'hostname', providerId: 'codex', workspaceId: 3 }

beforeEach(() => {
  reach.current = { label: 'MacBook Air', online: true, unreachable: false }
  activate.mockReset()
  toast.mockReset()
  openChatTab.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('openChildChat on another machine', () => {
  it('opens the agent once its machine switches in', async () => {
    activate.mockResolvedValue(true)
    expect(await openChildChat(remoteChild)).toBe(true)
    expect(activate).toHaveBeenCalledWith(3, 'air')
    expect(openChatTab).toHaveBeenCalledOnce()
  })

  it('says the machine is offline instead of opening, without asking it', async () => {
    reach.current = { label: 'MacBook Air', online: false, unreachable: true }
    expect(await openChildChat(remoteChild)).toBe(false)
    expect(activate).not.toHaveBeenCalled()
    expect(openChatTab).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('MacBook Air is offline', expect.anything())
  })

  it("gives up on a machine that doesn't answer in time", async () => {
    vi.useFakeTimers()
    activate.mockReturnValue(new Promise(() => {}))
    const opened = openChildChat(remoteChild)
    await vi.advanceTimersByTimeAsync(REMOTE_SWITCH_WAIT_MS)
    expect(await opened).toBe(false)
    expect(openChatTab).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith("Can't reach MacBook Air", expect.anything())
  })

  it('still opens the chat when the machine answered but no longer has that workspace', async () => {
    activate.mockResolvedValue(false)
    expect(await openChildChat(remoteChild)).toBe(true)
    expect(openChatTab).toHaveBeenCalledOnce()
  })
})
