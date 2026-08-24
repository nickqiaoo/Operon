import type { SqliteStorage } from '../../../storage/sqlite.js'
import type { ChannelRef, Choice, IMProvider } from '../types.js'
import type { SessionConfig, SessionConfigStore } from './session-config.js'
import { getProviders, getProviderModels } from '../../../services/ai.js'

export interface WizardDeps {
  provider: IMProvider
  storage: SqliteStorage
  sessionConfigStore: SessionConfigStore
}

/**
 * Shared workspace picker. Returns the selected workspaceId and display name,
 * or null if user aborted / no workspaces exist.
 */
export async function pickWorkspace(
  provider: IMProvider,
  ref: ChannelRef,
  storage: SqliteStorage,
): Promise<{ workspaceId: number; projectName: string } | null> {
  const projects = storage.listProjects()
  const workspaceChoices: Choice[] = []
  const workspaceMap = new Map<string, { workspaceId: number; projectName: string }>()

  for (const p of projects) {
    const workspaces = storage.listWorkspaces(p.id)
    if (workspaces.length <= 1) {
      const ws = workspaces[0]
      if (!ws) continue
      const dirName = ws.worktreePath.split('/').pop() || p.name
      const id = `w:${ws.id}`
      workspaceChoices.push({ id, label: `${p.name} (${dirName})` })
      workspaceMap.set(id, { workspaceId: ws.id, projectName: p.name })
    } else {
      for (const ws of workspaces) {
        const dirName = ws.worktreePath.split('/').pop() || ws.name
        const id = `w:${ws.id}`
        workspaceChoices.push({ id, label: `${p.name} / ${ws.name} (${dirName})` })
        workspaceMap.set(id, { workspaceId: ws.id, projectName: p.name })
      }
    }
  }

  if (workspaceChoices.length === 0) {
    await provider.send(ref, 'No workspaces found. Create a workspace in the desktop app first.')
    return null
  }

  try {
    const choice = await provider.askChoice(ref, 'Select a workspace:', workspaceChoices)
    const entry = workspaceMap.get(choice)
    return entry ?? null
  } catch (err) {
    console.error('[Wizard] Workspace selection failed:', err)
    return null
  }
}

export interface WizardResult {
  success: boolean
  config?: SessionConfig
  projectName?: string
}

/**
 * Sequential setup wizard driven by provider.askChoice. Blocks until the user
 * completes or aborts. Safe to call concurrently for different channels —
 * state is local to each call.
 */
export async function runSetupWizard(
  deps: WizardDeps,
  ref: ChannelRef,
): Promise<WizardResult> {
  const { provider, storage, sessionConfigStore } = deps
  const channelKey = providerChannelKey(provider, ref)

  // Step 1: Provider selection
  const providers = getProviders().filter((p) => p.available)
  if (providers.length === 0) {
    await provider.send(ref,
      'No AI providers available. Configure providers in the desktop app first.')
    return { success: false }
  }

  let providerId: string
  if (providers.length === 1) {
    providerId = providers[0].id
    console.log(`[Interactive:Wizard] Auto-selected provider=${providerId}`)
  } else {
    const providerChoices: Choice[] = providers.map((p) => ({ id: p.id, label: p.label }))
    try {
      providerId = await provider.askChoice(ref, 'Select an AI provider:', providerChoices)
    } catch (err) {
      console.error('[Interactive:Wizard] Provider selection failed:', err)
      return { success: false }
    }
  }

  // Step 2: Workspace selection
  const picked = await pickWorkspace(provider, ref, storage)
  if (!picked) return { success: false }
  const { workspaceId, projectName } = picked

  // Step 3: Model selection (optional)
  let modelId: string | undefined
  try {
    const result = await getProviderModels(providerId)
    if (result.models?.length) {
      const modelChoices: Choice[] = [
        { id: '__default__', label: 'Use default' },
        ...result.models.map((m: { modelId: string; name: string }) => ({
          id: m.modelId,
          label: m.modelId === result.currentModelId ? `✅ ${m.name}` : m.name,
        })),
      ]
      const chosen = await provider.askChoice(ref, 'Select a model:', modelChoices)
      if (chosen !== '__default__') modelId = chosen
    }
  } catch (err) {
    console.warn('[Interactive:Wizard] Failed to get models, skipping:', err)
  }

  const config: SessionConfig = { providerId, modelId, workspaceId }
  sessionConfigStore.set(channelKey, config)

  const modelLine = modelId ? `**Model**: ${modelId}\n` : ''
  await provider.send(ref,
    `**Session ready!**\n\n` +
    `**Provider**: ${providerId}\n` +
    `**Workspace**: ${projectName || 'workspace'}\n` +
    modelLine +
    `\nSend a message to start chatting.`,
  )

  console.log(`[Interactive:Wizard] Complete: key=${channelKey} provider=${providerId} workspace=${workspaceId}`)
  return { success: true, config, projectName }
}

function providerChannelKey(provider: IMProvider, ref: ChannelRef): string {
  return `${provider.providerId}:${ref.sourceChannel}:${ref.threadRef ?? '0'}`
}
