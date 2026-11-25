import { useCallback, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { useChatApi, useChatNodeId } from '@/lib/chat-api-context'
import { trackTurnSettingsSave } from '@/lib/turn-settings-saves'

type PermissionDecision = 'allow' | 'deny' | 'allowAlways'

type ModeOption = {
  value: string
}

export function useChatSessionControls({
  providerId,
  selectedModelProviderId,
  addToolApprovalResponse,
  currentTabChatId,
  currentDbChatId,
  setMode,
  sendMessage,
  chatBodyRef,
  setModel,
  canDynamicSwitch,
  saveTurnSettings = false,
  modeOptions,
}: {
  providerId?: string
  selectedModelProviderId?: string
  addToolApprovalResponse: (input: { id: string; approved: boolean; reason?: string }) => PromiseLike<void> | void
  currentTabChatId?: number
  currentDbChatId?: number
  setMode: (mode: string) => void
  sendMessage: (message: { text: string }) => void
  chatBodyRef: MutableRefObject<Record<string, unknown>>
  setModel: (modelId: string) => void
  canDynamicSwitch: boolean
  /**
   * Save a model / mode pick on the server at once even when the live session
   * cannot switch: an agent's chat also runs turns its parent starts, which
   * take what is saved rather than what this tab shows.
   */
  saveTurnSettings?: boolean
  modeOptions: ModeOption[]
}) {
  const api = useChatApi()
  const nodeId = useChatNodeId()
  const pushSettings = canDynamicSwitch || saveTurnSettings
  const save = useCallback((chatId: number, patch: { modelId?: string; modeId?: string }) => {
    void trackTurnSettingsSave({ nodeId, chatId }, api.aiCCDynamicSet({ chatId, ...patch }))
  }, [api, nodeId])
  const handlePermissionDecide = useCallback(async (
    id: string,
    outcome: PermissionDecision,
    updatedInput?: Record<string, unknown>,
  ) => {
    // Every provider (incl. custom/operon) resolves approvals through the HTTP
    // permission endpoint → sessionManager.resolvePermission, which unblocks the
    // still-open runtime stream. (custom used to ride aisdk's addToolApprovalResponse
    // + sendAutomaticallyWhen resubmit, but the operon runtime now blocks the turn
    // awaiting resolvePermission, so that resubmit never fired and the turn hung.)
    const resolvedChatId = currentTabChatId ?? currentDbChatId
    if (resolvedChatId === undefined) return false

    if (id.startsWith('plan-approval-')) {
      if (outcome === 'deny') {
        await addToolApprovalResponse({ id, approved: false })
      } else {
        const executionMode = modeOptions.find((option) => option.value.toLowerCase() !== 'plan')?.value
        if (executionMode) {
          setMode(executionMode)
          chatBodyRef.current.modeId = executionMode
        }
        sendMessage({ text: 'Implement the plan.' })
      }
      return true
    }

    const permissionOutcome = updatedInput
      ? { outcome, updatedInput }
      : outcome

    try {
      const response = await api.aiPermissionResponse({
        id,
        outcome: permissionOutcome,
        chatId: resolvedChatId,
      })
      if (!response.success) {
        toast.error('This approval is no longer pending.')
      }
      return response.success
    } catch {
      toast.error('Could not submit the approval. Please try again.')
      return false
    }
  }, [
    addToolApprovalResponse,
    chatBodyRef,
    currentDbChatId,
    currentTabChatId,
    modeOptions,
    providerId,
    selectedModelProviderId,
    sendMessage,
    setMode,
  ])

  const handleSetModel = useCallback((id: string) => {
    setModel(id)
    if (pushSettings && currentDbChatId) {
      save(currentDbChatId, { modelId: id })
    }
  }, [pushSettings, currentDbChatId, setModel, save])

  const handleSetMode = useCallback((mode: string) => {
    if (!modeOptions.some((option) => option.value === mode)) return
    setMode(mode)
    chatBodyRef.current.modeId = mode
    if (pushSettings && currentDbChatId) {
      save(currentDbChatId, { modeId: mode })
    }
  }, [modeOptions, setMode, chatBodyRef, pushSettings, currentDbChatId, save])

  return {
    handlePermissionDecide,
    handleSetModel,
    handleSetMode,
  }
}
