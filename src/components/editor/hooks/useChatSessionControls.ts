import { useCallback, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'

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
  cycleMode,
  modeOptions,
  currentMode,
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
  cycleMode: () => void
  modeOptions: ModeOption[]
  currentMode: string
}) {
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
    if (canDynamicSwitch && currentDbChatId) {
      void api.aiCCDynamicSet({ chatId: currentDbChatId, modelId: id })
    }
  }, [canDynamicSwitch, currentDbChatId, setModel])

  const handleCycleMode = useCallback(() => {
    if (!modeOptions.length) {
      cycleMode()
      return
    }

    if (!canDynamicSwitch) {
      cycleMode()
      return
    }

    const currentIndex = modeOptions.findIndex((option) => option.value === currentMode)
    let nextIndex = (currentIndex + 1) % modeOptions.length

    while (modeOptions[nextIndex]?.value === 'bypassPermissions' && nextIndex !== currentIndex) {
      nextIndex = (nextIndex + 1) % modeOptions.length
    }

    const nextMode = modeOptions[nextIndex]
    if (!nextMode || nextMode.value === currentMode) return

    setMode(nextMode.value)
    chatBodyRef.current.modeId = nextMode.value
    if (currentDbChatId) {
      void api.aiCCDynamicSet({ chatId: currentDbChatId, modeId: nextMode.value })
    }
  }, [canDynamicSwitch, chatBodyRef, currentDbChatId, currentMode, cycleMode, modeOptions, setMode])

  return {
    handlePermissionDecide,
    handleSetModel,
    handleCycleMode,
  }
}
