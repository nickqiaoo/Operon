import type { UIMessage } from 'ai'
import type { ChatStorageAdapter, ProjectStorageAdapter, TaskStorageAdapter } from '../../storage/interface.js'
import type { ChatHistoryListItem, ChatMeta } from '../../types/chat.js'
import type { Project, Workspace } from '../../types/project.js'
import type { PendingInputSummary } from '../../../../shared/pending-input.js'
import { isChatTurnBusy, listBusyChats } from '../ai/chat-turn-lifecycle.js'
import { listChatsAwaitingInput, listPendingApprovals } from '../ai/chat-pending-input.js'
import { getDiffStat } from '../git.js'
import { MAX_PAGE, emptyPage, pageRange } from './paging.js'

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
  /** Every chat with a turn starting or running. */
  busy(): number[]
  pending(chatId: number): PendingInputSummary[]
  /** Every chat waiting on the user. */
  awaiting(): Array<{ chatId: number; pending: PendingInputSummary[] }>
  /** Uncommitted changes in a worktree, file → lines added / removed. */
  diffStat(path: string): Promise<Record<string, { additions: number; deletions: number }>>
}

const appLiveState: OperonLiveState = {
  isBusy: isChatTurnBusy,
  busy: listBusyChats,
  pending: listPendingApprovals,
  awaiting: listChatsAwaitingInput,
  diffStat: async (path) => {
    const { staged, unstaged } = await getDiffStat(path)
    return { ...staged, ...unstaged }
  },
}

/** Kinds of chat that are not someone's conversation in a workspace. */
const HIDDEN_CHAT_TYPES = new Set(['side', 'canvas', 'workflow-agent'])
/** Conversations per page of a workspace overview. */
const OVERVIEW_CHATS = 15
/** Only the most recent conversations carry their last reply; older ones are just listed. */
const OVERVIEW_REPLIES = 5
const OVERVIEW_TASKS = 20
const PREVIEW_CHARS = 200

export interface OperonState {
  /** `projectId`: only that project. `activeOnly`: only workspaces with something running or waiting. */
  workspaceList(filter?: { projectId?: number; activeOnly?: boolean }): string
  /** `offset` pages the conversations; the changes and the board come with the first page only. */
  workspaceOverview(workspaceId: number, offset?: number): Promise<string>
  /** `offset` pages them; in practice far fewer than a page run at once. */
  runningList(offset?: number): string
  waitingList(): string
}

/** A conversation with something going on: a turn running, or a question for the user. */
interface LiveChat {
  chatId: number
  meta: ChatMeta
  pending: PendingInputSummary[]
}

export function createOperonState(storage: OperonStateStorage, live: OperonLiveState = appLiveState, now = () => Date.now()): OperonState {
  /** Every conversation in the workspace, most recent first: rows without messages, so cheap. */
  const workspaceChats = (workspaceId: number): ChatHistoryListItem[] =>
    storage.listChatEntries({ workspaceId }).filter((c) => !HIDDEN_CHAT_TYPES.has(c.tp))

  /** Straight from what is live in memory, so none is missed however old the conversation. */
  const liveChats = (): LiveChat[] => {
    const waiting = new Map(live.awaiting().map((a) => [a.chatId, a.pending]))
    const result: LiveChat[] = []
    for (const chatId of new Set([...live.busy(), ...waiting.keys()])) {
      const meta = storage.getChatMeta(chatId)
      if (!meta || HIDDEN_CHAT_TYPES.has(meta.tp)) continue
      result.push({ chatId, meta, pending: waiting.get(chatId) ?? [] })
    }
    return result.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
  }

  const agentOf = (providerId: string | undefined, model: string | undefined): string => {
    // `custom` is the app's own agent, which the user knows as operon.
    const provider = providerId === 'custom' ? 'operon' : providerId
    return [provider, model].filter(Boolean).join(' / ') || 'unknown agent'
  }

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
    const head = `- chat ${chat.id} · ${agentOf(chat.providerId, chat.model)} · ${state} · "${chat.title || 'Untitled'}" · updated ${ago(chat.updatedAt)}`
    const reply = withReply && state === 'idle' ? lastReply(chat.id) : undefined
    return reply ? `${head}\n  last reply: ${reply}` : head
  }

  const workspaceLabel = (workspace: Workspace, project?: Project): string =>
    `workspace ${workspace.id} "${workspace.name}"${project ? ` in project "${project.name}"` : ''}`

  const whereIs = (meta: ChatMeta): string => {
    const ws = meta.workspaceId != null ? storage.getWorkspace(meta.workspaceId) : undefined
    return ws ? workspaceLabel(ws, storage.getProject(ws.projectId) ?? undefined) : 'no workspace'
  }

  return {
    workspaceList({ projectId, activeOnly = false } = {}) {
      let projects: Project[]
      if (projectId != null) {
        const one = storage.getProject(projectId)
        if (!one) return `There is no project ${projectId}. Call workspace_list without it for the ids.`
        projects = [one]
      } else projects = storage.listProjects()
      if (!projects.length) return 'No projects yet.'

      const counts = new Map<number, { running: number; waiting: number }>()
      for (const chat of liveChats()) {
        if (chat.meta.workspaceId == null) continue
        const c = counts.get(chat.meta.workspaceId) ?? { running: 0, waiting: 0 }
        // Waiting on the user is not also counted as running.
        if (chat.pending.length) c.waiting++
        else c.running++
        counts.set(chat.meta.workspaceId, c)
      }

      const lines: string[] = []
      for (const project of projects) {
        const rows: string[] = []
        const workspaces = storage.listWorkspaces(project.id)
        for (const ws of workspaces) {
          const c = counts.get(ws.id)
          const activity = [c?.running && `${c.running} running`, c?.waiting && `${c.waiting} waiting for the user`].filter(Boolean).join(', ')
          if (activeOnly && !activity) continue
          rows.push(`  - workspace ${ws.id} "${ws.name}" · branch ${ws.branchName} · ${ws.worktreePath}${activity ? ` · ${activity}` : ''}`)
        }
        if (activeOnly && !rows.length) continue
        lines.push(`Project ${project.id} "${project.name}" — ${project.rootPath}`, ...(rows.length ? rows : ['  (no workspaces)']))
      }
      if (!lines.length) return 'Nothing is running or waiting for the user in any workspace.'
      return lines.join('\n')
    },

    async workspaceOverview(workspaceId, offset = 0) {
      const ws = storage.getWorkspace(workspaceId)
      if (!ws) return `There is no workspace ${workspaceId}. Call workspace_list for the ids.`
      const project = storage.getProject(ws.projectId) ?? undefined
      const lines = [`${workspaceLabel(ws, project)} · branch ${ws.branchName} · ${ws.worktreePath}`]
      const all = workspaceChats(ws.id)
      const chats = all.slice(offset, offset + OVERVIEW_CHATS)

      // A later page is only more conversations.
      if (offset > 0) {
        if (!chats.length) return `${lines[0]}\n${emptyPage(offset, all.length, 'No conversations yet.')}`
        lines.push(`Conversations, most recent first (${pageRange(offset, chats.length, all.length)}):`)
        chats.forEach((chat, i) => lines.push(chatLine(chat, i < OVERVIEW_REPLIES)))
        return lines.join('\n')
      }

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

      lines.push('', chats.length ? `Conversations, most recent first (${pageRange(0, chats.length, all.length)}):` : 'No conversations yet.')
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
        if (open.length > OVERVIEW_TASKS) lines.push(`- … and ${open.length - OVERVIEW_TASKS} more: board_list with offset ${OVERVIEW_TASKS} for the rest`)
      }
      return lines.join('\n')
    },

    runningList(offset = 0) {
      const chats = liveChats()
      const running = chats.filter((c) => !c.pending.length)
      const waiting = chats.length - running.length
      const shown = running.slice(offset, offset + MAX_PAGE)
      const lines = shown.map((c) =>
        `- chat ${c.chatId} · ${agentOf(c.meta.providerId, c.meta.model)} · "${c.meta.title || 'Untitled'}" (${whereIs(c.meta)})${c.meta.tp === 'chat' ? '' : ` · ${c.meta.tp}`} · updated ${ago(c.meta.updatedAt)}`)
      const head = shown.length
        ? [`Running now, most recent first (${pageRange(offset, shown.length, running.length)}):`]
        : [emptyPage(offset, running.length, 'Nothing is running right now.')]
      const tail = waiting ? [`${waiting} more ${waiting === 1 ? 'is' : 'are'} waiting for the user: waiting_list says on what.`] : []
      return [...head, ...lines, ...tail].join('\n')
    },

    waitingList() {
      const lines: string[] = []
      for (const { chatId, meta, pending } of liveChats()) {
        if (!pending.length) continue
        lines.push(`- chat ${chatId} "${meta.title || 'Untitled'}" (${whereIs(meta)}) · ${pending.map(describePending).join('; ')}`)
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
