import { getChatStorage } from '../ai/state.js'
import { TaskBoardService, type SwitchToolInput, type TaskBoardStorage, type ToolResult } from '../agent-comm/task-board-service.js'
import { getOrCreateWorkspaceAssistant } from '../workspace-assistant.js'

/**
 * OperonSpec from the personal assistant: the same board service a workspace chat
 * uses, with a hidden chat row per spec as its source (`ChatMetadata.assistantSpec`).
 * What a spec reports comes back through workflow/completion.ts.
 */

export interface AssistantSpecCard {
  projectId: number
  taskId: number
  taskNumber: number
  title: string
}

export interface AssistantSpecStart {
  projectId: number
  title: string
  brief: string
  /** The agent the lead runs on. */
  providerId: string
  /** `default`: that agent's own model. */
  model: string
  candidates?: string[]
}

export interface AssistantSpecs {
  start(input: AssistantSpecStart): Promise<string>
  answer(projectId: number, task: number, answers: string): Promise<string>
  status(projectId: number, task: number): Promise<string>
  switchAgent(projectId: number, task: number, input: SwitchToolInput): Promise<string>
  declineSwitch(projectId: number, task: number, note?: string): Promise<string>
  messageCoordinator(projectId: number, task: number, message: string): Promise<string>
}

function textOf(result: string | ToolResult): string {
  if (typeof result === 'string') return result
  if (result.isError) throw new Error(result.text)
  return result.text
}

export function createAssistantSpecs(storage: TaskBoardStorage, card: (spec: AssistantSpecCard) => void): AssistantSpecs {
  const chats = () => {
    const found = getChatStorage()
    if (!found) throw new Error('Chats are not available yet.')
    return found
  }

  /** The board as the spec's source chat, which only a spec the assistant started has. */
  const asSource = (projectId: number, number: number): TaskBoardService => {
    const task = storage.taskGetByNumber(projectId, number)
    if (!task) throw new Error(`Task #${number} is not on project ${projectId}'s board.`)
    const sourceChatId = task.sourceChatId
    if (sourceChatId == null || !chats().getChatMeta(sourceChatId)?.metadata?.assistantSpec) {
      throw new Error(`Spec #${number} was not started here; the user answers it in the conversation it was started from.`)
    }
    return new TaskBoardService(storage, projectId, sourceChatId)
  }

  return {
    async start({ projectId, title, brief, providerId, model, candidates }) {
      if (!storage.getProject(projectId)) throw new Error(`There is no project ${projectId}. Call workspace_list for the ids.`)
      const history = chats()
      const chatId = history.createChat({
        tp: 'workflow-agent',
        title: `Spec: ${title}`,
        providerId,
        ...(model === 'default' ? {} : { model }),
        updatedAt: Date.now(),
        metadata: { assistantSpec: { projectId } },
      })
      const agent = getOrCreateWorkspaceAssistant(storage, { provider: providerId, ...(model === 'default' ? {} : { model }) })
      const result = await new TaskBoardService(storage, projectId, chatId)
        .startSpec({ title, brief, ...(candidates?.length ? { candidates } : {}) }, agent.id)
        .catch((error: unknown): ToolResult => ({ text: error instanceof Error ? error.message : String(error), isError: true }))
      if (result.isError || !result.structured) {
        history.deleteChatEntry(chatId)
        throw new Error(result.text)
      }
      const { taskId, taskNumber, title: taskTitle } = result.structured
      card({ projectId, taskId, taskNumber, title: taskTitle })
      return `${result.text}\nThe user sees a card for it in this thread. You get a "[Spec update]" notice when it needs them; end your turn rather than polling.`
    },

    async answer(projectId, task, answers) {
      return textOf(await asSource(projectId, task).answerSpecQuestions(task, answers))
    },
    async status(projectId, task) {
      return textOf(await new TaskBoardService(storage, projectId).specStatus(task))
    },
    async switchAgent(projectId, task, input) {
      return textOf(await asSource(projectId, task).specSwitchAgent(task, input))
    },
    async declineSwitch(projectId, task, note) {
      return textOf(await asSource(projectId, task).specDeclineSwitch(task, note))
    },
    async messageCoordinator(projectId, task, message) {
      return textOf(await asSource(projectId, task).specMessageCoordinator(task, message))
    },
  }
}
