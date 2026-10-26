import { beforeEach, expect, it, vi } from 'vitest'
import { openWorkspaceFilePreview } from './workspace-file-preview'
import type { Project } from '@/stores/project-store'
import type { Tab } from '@/components/app-shell/tabs/types'

const state = vi.hoisted(() => ({
  activeRoot: '/unrelated' as string | null,
  projects: [] as Project[],
  tabs: [] as Tab[],
  openTab: vi.fn(),
  updateTab: vi.fn(),
  activateTab: vi.fn(),
  toggleWorkspaceTree: vi.fn(),
  setRightPanelOpen: vi.fn(),
}))
vi.mock('@/stores/project-store', () => ({ useProjectStore: { getState: () => ({
  projects: state.projects,
  getActiveWorkspace: () => state.activeRoot ? { worktreePath: state.activeRoot } : null,
}) } }))
vi.mock('@/stores/tabs-store', () => ({ useTabsStore: { getState: () => ({
  right: { tabs: state.tabs },
  openTab: state.openTab,
  updateTab: state.updateTab,
  activateTab: state.activateTab,
}) } }))
vi.mock('@/stores/app-shell-store', () => ({ useAppShellStore: { getState: () => ({
  setRightPanelOpen: state.setRightPanelOpen,
  toggleWorkspaceTree: state.toggleWorkspaceTree,
}) } }))

beforeEach(() => {
  vi.clearAllMocks()
  state.activeRoot = '/unrelated'
  state.projects = []
  state.tabs = []
  state.openTab.mockImplementation((_panel: string, tab: Tab) => state.tabs.push(tab))
  state.updateTab.mockImplementation((_panel: string, tabId: string, update: Partial<Tab>) => {
    state.tabs = state.tabs.map((tab) => tab.tabId === tabId ? { ...tab, ...update } : tab)
  })
})

it('opens a reference in its source directory regardless of the active workspace', () => {
  expect(openWorkspaceFilePreview('/source/src/app.ts', { rootPath: '/source', line: 42 })).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/source', selectedPath: '/source/src/app.ts', gotoLine: 42 }),
  }))
  expect(state.toggleWorkspaceTree).toHaveBeenCalledWith(state.tabs[0].tabId)
})

it('keeps relative references in their original workspace', () => {
  expect(openWorkspaceFilePreview('app.ts')).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/unrelated', selectedPath: '/unrelated/app.ts' }),
  }))
})

it('opens an absolute reference outside the source in its containing directory', () => {
  expect(openWorkspaceFilePreview('/other/src/app.ts', { rootPath: '/source', line: 42 })).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/other/src', selectedPath: '/other/src/app.ts', gotoLine: 42 }),
  }))
})

it('uses the most specific owning workspace for a cross-project absolute reference', () => {
  state.projects = [{
    id: 1, name: 'xui', rootPath: '/projects/xui', createdAt: 0, updatedAt: 0,
    workspaces: [{ id: 1, name: 'feature', branchName: 'feature', worktreePath: '/projects/xui/worktrees/feature' }],
  }]
  const path = '/projects/xui/worktrees/feature/src/app.ts'
  expect(openWorkspaceFilePreview(path, { rootPath: '/projects/blog', line: 110 })).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/projects/xui/worktrees/feature', selectedPath: path, gotoLine: 110 }),
  }))
  expect(state.activeRoot).toBe('/unrelated')
})

it('opens absolute references even when no workspace is active', () => {
  state.activeRoot = null
  expect(openWorkspaceFilePreview('/tmp/example.ts', { line: 7 })).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/tmp', selectedPath: '/tmp/example.ts', gotoLine: 7 }),
  }))
})

it('does not guess a workspace for unresolved or escaping relative references', () => {
  expect(openWorkspaceFilePreview('../other/app.ts', { rootPath: '/source' })).toBe(false)
  expect(openWorkspaceFilePreview('/source', { rootPath: '/source' })).toBe(false)
  state.activeRoot = null
  expect(openWorkspaceFilePreview('src/app.ts')).toBe(false)
  expect(state.openTab).not.toHaveBeenCalled()
})

it('does not confuse similarly named directories or dot segments with the source', () => {
  expect(openWorkspaceFilePreview('/source-old/src/../app.ts', { rootPath: '/source' })).toBe(true)
  expect(state.openTab).toHaveBeenCalledWith('right', expect.objectContaining({
    payload: expect.objectContaining({ rootPath: '/source-old', selectedPath: '/source-old/app.ts' }),
  }))
})

it('reuses the file tree and repeats line jumps without replacing previously opened files', () => {
  const path = '/other/src/app.ts'
  openWorkspaceFilePreview(path, { line: 42 })
  openWorkspaceFilePreview('/other/src/test.ts')
  openWorkspaceFilePreview(path, { line: 42 })
  expect(state.openTab).toHaveBeenCalledTimes(1)
  expect(state.toggleWorkspaceTree).toHaveBeenCalledTimes(1)
  expect(state.activateTab).toHaveBeenCalledWith('right', state.tabs[0].tabId)
  expect(state.tabs[0].payload).toMatchObject({
    rootPath: '/other/src', selectedPath: path, gotoLine: 42,
    openPaths: [path, '/other/src/test.ts'],
  })
  const previous = state.tabs[0].payload
  openWorkspaceFilePreview(path, { line: 42 })
  expect(state.tabs[0].payload).toMatchObject({
    gotoNonce: previous.type === 'workspace-browser' ? (previous.gotoNonce ?? 0) + 1 : 1,
  })
})
