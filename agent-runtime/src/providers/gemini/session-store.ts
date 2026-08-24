import {
  SESSION_FILE_PREFIX,
  partListUnionToString,
  type Config,
  type ConversationRecord,
  type ResumedSessionData,
} from '@google/gemini-cli-core'
import type { Content, Part } from '@google/genai'
import fs from 'node:fs/promises'
import path from 'node:path'

const RESUME_LATEST = 'latest'

type SessionFileEntry = {
  conversation: ConversationRecord
  filePath: string
}

async function resolveSessionFile(chatsDir: string, identifier: string): Promise<ResumedSessionData> {
  let files: string[] = []
  try {
    files = await fs.readdir(chatsDir)
  } catch {
    throw new Error(`Could not read chats directory: ${chatsDir}`)
  }

  const sessionEntries: SessionFileEntry[] = []
  for (const file of files) {
    if (!file.startsWith(SESSION_FILE_PREFIX) || !file.endsWith('.json')) continue
    const filePath = path.join(chatsDir, file)
    try {
      const content = await fs.readFile(filePath, 'utf8')
      const conversation = JSON.parse(content) as ConversationRecord
      if (conversation.sessionId && conversation.startTime) {
        sessionEntries.push({ conversation, filePath })
      }
    } catch {
      // ignore invalid files
    }
  }

  if (sessionEntries.length === 0) {
    throw new Error('No valid sessions found.')
  }

  sessionEntries.sort(
    (left, right) =>
      new Date(left.conversation.startTime).getTime() - new Date(right.conversation.startTime).getTime(),
  )

  if (identifier === RESUME_LATEST) {
    return sessionEntries[sessionEntries.length - 1]
  }

  const byUuid = sessionEntries.find((entry) => entry.conversation.sessionId === identifier)
  if (byUuid) return byUuid

  const index = Number.parseInt(identifier, 10)
  if (!Number.isNaN(index) && index > 0 && index <= sessionEntries.length) {
    return sessionEntries[index - 1]
  }

  throw new Error(`Session identifier '${identifier}' not found.`)
}

export async function loadSession(config: Config, sessionIdOrPath: string = RESUME_LATEST): Promise<ResumedSessionData> {
  const chatsDir = path.join(config.storage.getProjectTempDir(), 'chats')
  try {
    const stats = await fs.stat(sessionIdOrPath)
    if (stats.isFile()) {
      const content = await fs.readFile(sessionIdOrPath, 'utf8')
      const conversation = JSON.parse(content) as ConversationRecord
      return { conversation, filePath: sessionIdOrPath }
    }
  } catch {
    // continue with identifier resolution
  }
  return resolveSessionFile(chatsDir, sessionIdOrPath)
}

export function convertToHistory(conversation: ConversationRecord): Content[] {
  const clientHistory: Content[] = []

  for (const message of conversation.messages) {
    if (message.type === 'info' || message.type === 'error' || message.type === 'warning') {
      continue
    }

    if (message.type === 'user') {
      const contentString = partListUnionToString(message.content)
      if (contentString.trim().startsWith('/') || contentString.trim().startsWith('?')) {
        continue
      }
      clientHistory.push({
        role: 'user',
        parts: Array.isArray(message.content)
          ? (message.content as Part[])
          : [{ text: contentString }],
      })
      continue
    }

    if (message.type !== 'gemini') continue

    const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0
    if (hasToolCalls) {
      const modelParts: Part[] = []
      const contentString = partListUnionToString(message.content)
      if (message.content && contentString.trim()) {
        modelParts.push({ text: contentString })
      }
      const toolCalls = message.toolCalls ?? []
      for (const toolCall of toolCalls) {
        modelParts.push({
          functionCall: {
            name: toolCall.name,
            args: toolCall.args,
            ...(toolCall.id ? { id: toolCall.id } : {}),
          },
        })
      }
      clientHistory.push({ role: 'model', parts: modelParts })

      const responseParts: Part[] = []
      for (const toolCall of toolCalls) {
        if (!toolCall.result) continue
        if (typeof toolCall.result === 'string') {
          responseParts.push({
            functionResponse: {
              id: toolCall.id,
              name: toolCall.name,
              response: { output: toolCall.result },
            },
          })
          continue
        }
        if (Array.isArray(toolCall.result)) {
          responseParts.push(...(toolCall.result as Part[]))
          continue
        }
        responseParts.push(toolCall.result as Part)
      }
      if (responseParts.length > 0) {
        clientHistory.push({ role: 'user', parts: responseParts })
      }
      continue
    }

    const contentString = partListUnionToString(message.content)
    if (message.content && contentString.trim()) {
      clientHistory.push({ role: 'model', parts: [{ text: contentString }] })
    }
  }

  return clientHistory
}
