import type { UIMessage } from 'ai'
import type { ChatStorageAdapter, ProjectStorageAdapter, TaskStorageAdapter } from '../../storage/interface.js'
import type { ChatHistoryListItem } from '../../types/chat.js'
import type { Project, Workspace } from '../../types/project.js'
import type { PendingInputSummary } from '../../../../shared/pending-input.js'
import { isChatTurnBusy } from '../ai/chat-turn-lifecycle.js'
import { listChatsAwaitingInput, listPendingApprovals } from '../ai/chat-pending-input.js'
import { getDiffStat } from '../git.js'

/**
 * What the main agent can read about the work in the rest of the app: projects, their workspaces,
 * the conversations in them and the board (docs/assistant/operon-manager.md §4). Read-only, local
 * and cheap — the main agent calls these itself instead of handing them to a worker. Answers are
 * plain text for the model.
 */

export type OperonStateStorage = Pick<ProjectStorageAdapter, 'listProjects' | 'listWorkspaces' | 'getWorkspace' | 'getProject'> &
  Pick<ChatStorageAdapter, 'listChatEntries' | 'getChatMeta' | 'getChatMessages'> &
  Pick<TaskStorageAdapter, 'taskList'>

/** The live state the app keeps in memory, separate so tests can stand in for it. */
export interface OperonLiveState {
  isBusy(chatId: number): boolean
  pending(chatId: number): PendingInputSummary[]
  /** Every chat waiting on the user. */
  awaiting(): Array<{ chatId: number; pending: PendingInputSummary[] }>
  /** Uncommitted changes in a worktree, file → lines added / removed. */
  diffStat(path: string): Promise<Record<string, { additions: number; deletions: number }>>
}

const appLiveState: OperonLiveState = {
  isBusy: isChatTurnBusy,
  pending: listPendingApprovals,
  awaiting: listChatsAwaitingInput,
  diffStat: async (path) => {
    const { staged, unstaged } = await getDiffStat(path)
    return { ...staged, ...unstaged }
  },
}

/** Kinds of chat that are not someone's conversation in a workspace. */
const HIDDEN_CHAT_TYPES = new Set(['side', 'canvas', 'workflow-agent'])
/** Recent conversations looked at per workspace — a running one is always among the latest. */
const RECENT_CHATS = 30
const OVERVIEW_CHATS = 15
/** Only the most recent conversations carry their last reply; older ones are just listed. */
const OVERVIEW_REPLIES = 5
const OVERVIEW_TASKS = 20
const PREVIEW_CHARS = 200

export interface OperonState {
  workspaceList(): string
  workspaceOverview(workspaceId: number): Promise<string>
  waitingList(): string
}

export function createOperonState(storage: OperonStateStorage, live: OperonLiveState = appLiveState, now = () => Date.now()): OperonState {
  const recentChats = (workspaceId: number, limit: number): ChatHistoryListItem[] =>
    storage.listChatEntries({ workspaceId, limit: limit + 10 }).filter((c) => !HIDDEN_CHAT_TYPES.has(c.tp)).slice(0, limit)

  const chatState = (chatId: number): string => {
    const pending = live.pending(chatId)
    if (pending.length) return `waiting for the user: ${pending.map(describePending).join('; ')}`
    return live.isBusy(chatId) ? 'running' : 'idle'
  }

  const lastReply = (chatId: number): string | undefined => {
    const page = storage.getChatMessages(chatId, { limit: 4 })
    const messages = (page?.messages ?? []) as UIMessage[]
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    // The last text part is where the agent concludes; earlier ones narrate the work.
    const text = last?.parts
      .filter((p) => p.type === 'text')
      .at(-1)
      ?.text.replace(/\s+/g, ' ')
      .trim()
    if (!text) {
      // A turn can end on a tool call with nothing said (a question cut off by a restart).
      const tool = last?.parts.filter((p) => p.type === 'dynamic-tool' || p.type.startsWith('tool-')).at(-1)
      if (!tool) return undefined
      const name = tool.type === 'dynamic-tool' ? tool.toolName : tool.type.slice('tool-'.length)
      return `(no text; its last turn ended on ${name})`
    }
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
  }

  const ago = (at: number): string => {
    const minutes = Math.round((now() - at) / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.round(minutes / 60)
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
  }

  const chatLine = (chat: ChatHistoryListItem, withReply: boolean): string => {
    const state = chatState(chat.id)
    // `custom` is the app's own agent, which the user knows as operon.
    const provider = chat.providerId === 'custom' ? 'operon' : chat.providerId
    const who = [provider, chat.model].filter(Boolean).join(' / ') || 'unknown agent'
    const head = `- chat ${chat.id} · ${who} · ${state} · "${chat.title || 'Untitled'}" · updated ${ago(chat.updatedAt)}`
    const reply = withReply && state === 'idle' ? lastReply(chat.id) : undefined
    return reply ? `${head}\n  last reply: ${reply}` : head
  }

  const workspaceLabel = (workspace: Workspace, project?: Project): string =>
    `workspace ${workspace.id} "${workspace.name}"${project ? ` in project "${project.name}"` : ''}`

  return {
    workspaceList() {
      const projects = storage.listProjects()
      if (!projects.length) return 'No projects yet.'
      const lines: string[] = []
      for (const project of projects) {
        lines.push(`Project ${project.id} "${project.name}" — ${project.rootPath}`)
        const workspaces = storage.listWorkspaces(project.id)
        if (!workspaces.length) lines.push('  (no workspaces)')
        for (const ws of workspaces) {
          const chats = recentChats(ws.id, RECENT_CHATS)
          const waiting = chats.filter((c) => live.pending(c.id).length > 0).length
          const running = chats.filter((c) => live.pending(c.id).length === 0 && live.isBusy(c.id)).length
          const activity = [running && `${running} running`, waiting && `${waiting} waiting for the user`].filter(Boolean).join(', ')
          lines.push(`  - workspace ${ws.id} "${ws.name}" · branch ${ws.branchName} · ${ws.worktreePath}${activity ? ` · ${activity}` : ''}`)
        }
      }
      return lines.join('\n')
    },

    async workspaceOverview(workspaceId) {
      const ws = storage.getWorkspace(workspaceId)
      if (!ws) return `There is no workspace ${workspaceId}. Call workspace_list for the ids.`
      const project = storage.getProject(ws.projectId) ?? undefined
      const lines = [`${workspaceLabel(ws, project)} · branch ${ws.branchName} · ${ws.worktreePath}`]

      try {
        const files = Object.values(await live.diffStat(ws.worktreePath))
        if (!files.length) lines.push('Uncommitted changes: none')
        else {
          const added = files.reduce((n, f) => n + f.additions, 0)
          const removed = files.reduce((n, f) => n + f.deletions, 0)
          lines.push(`Uncommitted changes: ${files.length} ${files.length === 1 ? 'file' : 'files'}, +${added} −${removed}`)
        }
      } catch {
        lines.push('Uncommitted changes: could not read the worktree')
      }

      const chats = recentChats(ws.id, OVERVIEW_CHATS)
      lines.push('', chats.length ? 'Conversations, most recent first:' : 'No conversations yet.')
      chats.forEach((chat, i) => lines.push(chatLine(chat, i < OVERVIEW_REPLIES)))

      const open = storage
        .taskList({ projectId: ws.projectId })
        .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
      if (open.length) {
        lines.push('', `Open board tasks in this project (${open.length}):`)
        for (const task of open.slice(0, OVERVIEW_TASKS)) {
          const here = task.workspaceId === ws.id ? ' · this workspace' : ''
          lines.push(`- #${task.number} [${task.status}] ${task.title}${here}`)
        }
        if (open.length > OVERVIEW_TASKS) lines.push(`- … and ${open.length - OVERVIEW_TASKS} more`)
      }
      return lines.join('\n')
    },

    waitingList() {
      const lines: string[] = []
      for (const { chatId, pending } of live.awaiting()) {
        const meta = storage.getChatMeta(chatId)
        if (!meta || HIDDEN_CHAT_TYPES.has(meta.tp)) continue
        const ws = meta.workspaceId != null ? storage.getWorkspace(meta.workspaceId) : undefined
        const where = ws ? workspaceLabel(ws, storage.getProject(ws.projectId) ?? undefined) : 'no workspace'
        lines.push(`- chat ${chatId} "${meta.title || 'Untitled'}" (${where}) · ${pending.map(describePending).join('; ')}`)
      }
      return lines.length ? lines.join('\n') : 'Nothing is waiting for the user.'
    },
  }
}

export function describePending(p: PendingInputSummary): string {
  const from = p.origin ? ` from ${p.origin}` : ''
  if (p.toolName === 'AskUserQuestion') {
    const question = askedQuestion(p.inputPreview)
    // The question itself, quoted, says what is asked better than naming the tool.
    return `${question ? `"${question}"` : 'a question'}${from}`
  }
  if (p.toolName === 'ExitPlanMode') return `a plan to review${from}`
  const preview = p.inputPreview ? ` (${p.inputPreview.replace(/\s+/g, ' ').slice(0, 120)})` : ''
  return `${p.toolName}${preview}${from}`
}

/** The first question an AskUserQuestion preview carries. The preview is clipped JSON, so not parsed whole. */
function askedQuestion(preview: string | undefined): string | undefined {
  const match = preview && /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(preview)
  if (!match) return undefined
  try {
    return (JSON.parse(`"${match[1]}"`) as string).trim() || undefined
  } catch {
    return match[1]
  }
}
