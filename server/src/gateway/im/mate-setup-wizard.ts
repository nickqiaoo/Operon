/**
 * Mate setup wizard — runs when a mate binding has no workspace yet.
 *
 * Triggered by InboundPipeline on first message in a channel (or any message
 * where `binding.workspace_id` is NULL). Anyone in the channel can drive it:
 * the wizard answers via `provider.askChoice` on the same ChannelRef.
 *
 * Mate only needs to pick a workspace — provider/model come from the agent
 * record. User can either reuse an existing workspace or provision a fresh
 * worktree for this channel. On success, writes `workspace_id` onto the
 * binding so the next message wakes normally through wakeMate.
 */

import type { SqliteStorage } from '../../storage/sqlite.js'
import type { ChannelRef, Choice, IMProvider } from './types.js'
import { provisionAgentWorkspace } from '../../services/channel/agent-orchestrator.js'

export interface MateSetupWizardDeps {
  provider: IMProvider
  storage: SqliteStorage
  bindingId: number
  agentId: number
  ref: ChannelRef
}

type PickResult =
  | { kind: 'existing'; workspaceId: number; projectName: string }
  | { kind: 'new'; projectId: number; projectName: string }
  | null

export async function runMateSetupWizard(deps: MateSetupWizardDeps): Promise<boolean> {
  const { provider, storage, bindingId, agentId, ref } = deps

  const agent = storage.getAgent(agentId)
  if (!agent) {
    await provider.sendPlain(ref, '❌ Agent not found.')
    return false
  }

  await provider.sendPlain(
    ref,
    `**Setup required for ${agent.name}**\n` +
    `Pick or create a workspace for this channel. The agent will run in that ` +
    `workspace's worktree on every message here. Anyone in the channel can answer.`,
  )

  const picked = await pickOrCreateWorkspace(provider, storage, ref)
  if (!picked) return false

  let workspaceId: number
  let projectName: string
  if (picked.kind === 'existing') {
    workspaceId = picked.workspaceId
    projectName = picked.projectName
  } else {
    try {
      await provider.sendPlain(ref, `⏳ Provisioning worktree for ${agent.name} in ${picked.projectName}…`)
      const ws = await provisionAgentWorkspace(agentId, picked.projectId, {
        suffix: `binding${bindingId}`,
      })
      workspaceId = ws.id
      projectName = picked.projectName
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await provider.sendPlain(ref, `❌ Failed to create worktree: ${msg}`)
      return false
    }
  }

  // Backfill workspace + project on the binding. project_id is required for
  // inbox routing / list_team_peers; derive from the workspace.
  const ws = storage.getWorkspace(workspaceId)
  storage.updateBinding(bindingId, {
    workspaceId,
    projectId: ws?.projectId ?? null,
    status: 'idle',
  })

  await provider.send(
    ref,
    `✅ **${agent.name}** is now bound to **${projectName}**.\n` +
    `Send a message to start.`,
  )

  console.log(
    `[Mate:Wizard] binding=${bindingId} agent=${agentId} workspace=${workspaceId} kind=${picked.kind}`,
  )
  return true
}

async function pickOrCreateWorkspace(
  provider: IMProvider,
  storage: SqliteStorage,
  ref: ChannelRef,
): Promise<PickResult> {
  const projects = storage.listProjects()
  const choices: Choice[] = []
  const map = new Map<string, PickResult>()

  for (const p of projects) {
    const workspaces = storage.listWorkspaces(p.id)
    for (const ws of workspaces) {
      const dirName = ws.worktreePath.split('/').pop() || ws.name
      const id = `w:${ws.id}`
      choices.push({
        id,
        label: workspaces.length > 1 ? `${p.name} / ${ws.name} (${dirName})` : `${p.name} (${dirName})`,
      })
      map.set(id, { kind: 'existing', workspaceId: ws.id, projectName: p.name })
    }
    const createId = `n:${p.id}`
    choices.push({
      id: createId,
      label: `➕ New worktree in ${p.name}`,
    })
    map.set(createId, { kind: 'new', projectId: p.id, projectName: p.name })
  }

  if (choices.length === 0) {
    await provider.sendPlain(
      ref,
      'No projects found. Add a project in the desktop app first.',
    )
    return null
  }

  try {
    const chosen = await provider.askChoice(ref, 'Select a workspace:', choices)
    return map.get(chosen) ?? null
  } catch (err) {
    console.error('[Mate:Wizard] Workspace selection failed:', err)
    return null
  }
}
