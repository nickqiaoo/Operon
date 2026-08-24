import type { SessionManager } from '@operon/agent-runtime'
import type { ChannelRef, Choice, IMProvider } from './types.js'
import type { SessionConfigStore } from './interactive/session-config.js'

export interface PendingPermission {
  approvalId: string
  chatId: number // internal chats row id
  channelKey: string
  ref: ChannelRef
  toolName: string
  input: Record<string, unknown>
}

export interface PermissionHandlerDeps {
  sessionManager: SessionManager
  sessionConfigStore: SessionConfigStore
  /**
   * Custom-provider permission flow: dispatcher must mutate chat history and
   * re-issue startChat. Non-custom providers go directly through
   * sessionManager.resolvePermission.
   */
  runApprovalResponse: (
    channelKey: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ) => void
}

export interface PermissionHandler {
  addPending(permission: PendingPermission): void
  removePending(approvalId: string): PendingPermission | undefined
  hasPendingForChat(chatId: number): boolean
  sendPermissionRequest(
    provider: IMProvider,
    ref: ChannelRef,
    approvalId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<void>
  sendAskUserQuestion(
    provider: IMProvider,
    ref: ChannelRef,
    approvalId: string,
    input: Record<string, unknown>,
  ): Promise<void>
}

export function createPermissionHandler(deps: PermissionHandlerDeps): PermissionHandler {
  const pending = new Map<string, PendingPermission>()

  const removePending = (approvalId: string): PendingPermission | undefined => {
    const p = pending.get(approvalId)
    if (p) pending.delete(approvalId)
    return p
  }

  const resolvePermission = async (
    approvalId: string,
    choiceId: 'allow' | 'always' | 'deny',
  ): Promise<void> => {
    const perm = removePending(approvalId)
    if (!perm) return

    const sessionConfig = deps.sessionConfigStore.get(perm.channelKey)
    const isCustom = sessionConfig?.providerId === 'custom'

    if (isCustom) {
      const approved = choiceId !== 'deny'
      deps.runApprovalResponse(
        perm.channelKey,
        approvalId,
        approved,
        approved ? undefined : 'Denied via gateway',
      )
      return
    }

    const decision = choiceId === 'deny'
      ? { type: 'deny' as const, reason: 'Denied via gateway' }
      : { type: (choiceId === 'always' ? 'allow-always' : 'allow') as 'allow' | 'allow-always' }

    deps.sessionManager.resolvePermission(perm.chatId, approvalId, decision)
  }

  const resolveAskUser = async (
    approvalId: string,
    choiceId: string,
    questions: Array<{ question: string; options?: Array<{ label: string }> }>,
  ): Promise<void> => {
    const perm = removePending(approvalId)
    if (!perm) return

    const sessionConfig = deps.sessionConfigStore.get(perm.channelKey)
    const isCustom = sessionConfig?.providerId === 'custom'

    if (choiceId === 'cancel') {
      if (isCustom) {
        deps.runApprovalResponse(perm.channelKey, approvalId, false, 'Cancelled via gateway')
        return
      }
      deps.sessionManager.resolvePermission(perm.chatId, approvalId, {
        type: 'deny',
        reason: 'Cancelled via gateway',
      })
      return
    }

    const match = choiceId.match(/^q:(\d+):(\d+)$/)
    if (!match) return
    const questionIndex = parseInt(match[1], 10)
    const optionIndex = parseInt(match[2], 10)
    const q = questions[questionIndex]
    const selectedLabel = q?.options?.[optionIndex]?.label ?? ''

    if (isCustom) {
      deps.runApprovalResponse(perm.channelKey, approvalId, true)
      return
    }

    const answers: Record<string, string> = {}
    if (q) answers[q.question] = selectedLabel

    deps.sessionManager.resolvePermission(perm.chatId, approvalId, {
      type: 'allow',
      updatedInput: {
        questions: perm.input.questions,
        answers,
      },
    })
  }

  return {
    addPending(permission) {
      pending.set(permission.approvalId, permission)
    },
    removePending,
    hasPendingForChat(chatId) {
      for (const p of pending.values()) {
        if (p.chatId === chatId) return true
      }
      return false
    },

    sendPermissionRequest(provider, ref, approvalId, toolName, input) {
      const text = formatPermissionText(toolName, input)
      const choices: Choice[] = [
        { id: 'allow', label: '✅ Allow' },
        { id: 'always', label: '🔒 Always' },
        { id: 'deny', label: '❌ Deny' },
      ]
      provider.askChoice(ref, text, choices).then(
        (choiceId) => { void resolvePermission(approvalId, choiceId as 'allow' | 'always' | 'deny') },
        (err) => {
          console.error('[Interactive:Permission] askChoice failed:', err)
          pending.delete(approvalId)
        },
      )
      return Promise.resolve()
    },

    sendAskUserQuestion(provider, ref, approvalId, input) {
      const questions = (input.questions ?? []) as Array<{
        question: string
        header?: string
        options?: Array<{ label: string; description?: string }>
        multiSelect?: boolean
      }>

      if (questions.length === 0) {
        return this.sendPermissionRequest(provider, ref, approvalId, 'unknown', input)
      }

      let text = ''
      const choices: Choice[] = []

      for (let qIdx = 0; qIdx < questions.length; qIdx++) {
        const q = questions[qIdx]
        if (q.header) text += `**${q.header}**\n`
        text += `${q.question}\n\n`
        const options = q.options ?? []
        for (let oIdx = 0; oIdx < options.length; oIdx++) {
          const opt = options[oIdx]
          choices.push({
            id: `q:${qIdx}:${oIdx}`,
            label: opt.label,
            description: opt.description,
          })
        }
      }
      choices.push({ id: 'cancel', label: '❌ Cancel' })

      provider.askChoice(ref, text.trim(), choices).then(
        (choiceId) => { void resolveAskUser(approvalId, choiceId, questions) },
        (err) => {
          console.error('[Interactive:Permission] askChoice (AskUser) failed:', err)
          pending.delete(approvalId)
        },
      )
      return Promise.resolve()
    },
  }
}

function formatPermissionText(toolName: string, input: Record<string, unknown>): string {
  let text = `**Permission Required**\n\n`
  text += `**Tool**: \`${toolName}\`\n`

  if (input.command) {
    text += `**Command**: \`${String(input.command).slice(0, 200)}\`\n`
  } else if (input.file_path) {
    text += `**File**: \`${String(input.file_path)}\`\n`
  } else if (input.pattern) {
    text += `**Pattern**: \`${String(input.pattern)}\`\n`
  }
  return text
}
