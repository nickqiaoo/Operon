import { beforeEach, expect, it, vi } from 'vitest'
import { openWorkspaceFilePreview } from './workspace-file-preview'

const state = vi.hoisted(() => ({ openTab: vi.fn(), setRightPanelOpen: vi.fn() }))
vi.mock('@/stores/project-store', () => ({ useProjectStore: { getState: () => ({ getActiveWorkspace: () => ({ worktreePath: '/unrelated' }) }) } }))
vi.mock('@/stores/tabs-store', () => ({ useTabsStore: { getState: () => ({ right: { tabs: [] }, openTab: state.openTab }) } }))
vi.mock('@/stores/app-shell-store', () => ({ useAppShellStore: { getState: () => ({ setRightPanelOpen: state.setRightPanelOpen }) } }))

beforeEach(() => { vi.clearAllMocks() })

it('opens a reference in its source directory regardless of the active workspace', () => {
  expect(openWorkspaceFilePreview('/source/src/app.ts', { rootPath: '/source', line: 42 })).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/source', selectedPath: '/source/src/app.ts', gotoLine: 42 }),
  }))
})

it('rejects files outside the source and keeps ordinary preview behavior', () => {
  expect(openWorkspaceFilePreview('/other/app.ts', { rootPath: '/source' })).toBe(false)
  expect(state.openTab).not.toHaveBeenCalled()
  expect(openWorkspaceFilePreview('app.ts')).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/unrelated', selectedPath: '/unrelated/app.ts' }),
  }))
})
