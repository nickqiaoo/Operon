import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntlProvider } from 'react-intl'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/stores/project-store'
import type { DelegationMachine } from '@shared/delegations'
import { MobileContextSwitcher } from './MobileContextSwitcher'

const { state } = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) => selector(state),
}))
vi.mock('./MobileSheet', () => ({ MobileSheet: ({ children }: { children: ReactNode }) => <div>{children}</div> }))

const project = (id: number, name: string, workspaceId: number, workspaceName: string) => ({
  id, name, rootPath: `/${name}`,
  workspaces: [{ id: workspaceId, name: workspaceName, worktreePath: `/${name}` }],
}) as unknown as Project

const machine = { nodeId: 'node-b', label: 'mac-mini.local', online: true, current: false, paired: true } as DelegationMachine

const render = (machineTrees: { machine: DelegationMachine; projects: Project[] }[]) => renderToStaticMarkup(
  <IntlProvider locale="en">
    <MobileContextSwitcher
      open
      onClose={() => {}}
      selectedSpecId={null}
      onSelectSpec={() => {}}
      onSelectWorkspace={() => {}}
      machineTrees={machineTrees}
      thisMachineLabel="laptop"
    />
  </IntlProvider>,
)

describe('mobile context switcher with other machines', () => {
  beforeEach(() => {
    Object.assign(state, {
      projects: [project(1, 'operon', 7, 'main')],
      activeProjectId: 1,
      activeWorkspaceId: 7,
      activeNodeId: null,
      hiddenSpecIds: [],
      shownSpecIds: [],
    })
  })

  it('lists only this machine, ungrouped, when there are no others', () => {
    const html = render([])
    expect(html).toContain('operon')
    expect(html).not.toContain('mobile-context-machine')
  })

  it('groups projects by machine and marks the current workspace on its own machine only', () => {
    // Ids are per machine: workspace 7 exists on both.
    const html = render([{ machine, projects: [project(1, 'server', 7, 'deploy')] }])
    expect(html).toContain('data-testid="mobile-context-machine-local"')
    expect(html).toContain('laptop')
    expect(html).toContain('data-testid="mobile-context-machine-node-b"')
    expect(html).toContain('mac-mini')
    expect(html).not.toContain('mac-mini.local<')
    expect(html.indexOf('operon')).toBeLessThan(html.indexOf('server'))
    expect(html.match(/lucide-check/g)).toHaveLength(1)
    expect(html.indexOf('lucide-check')).toBeLessThan(html.indexOf('mobile-context-machine-node-b'))
  })

  it('marks the remote workspace once it is current', () => {
    state.activeNodeId = 'node-b'
    const html = render([{ machine, projects: [project(1, 'server', 7, 'deploy')] }])
    expect(html.match(/lucide-check/g)).toHaveLength(1)
    expect(html.indexOf('lucide-check')).toBeGreaterThan(html.indexOf('mobile-context-machine-node-b'))
  })
})
