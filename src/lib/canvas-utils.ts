export interface CanvasChatId {
  type: 'canvas'
  runId: number
  nodeId: string
}

export function parseCanvasChatId(chatId: string): CanvasChatId | null {
  const match = chatId.match(/^canvas:([^:]+):([^:]+)$/)
  if (!match) return null

  return {
    type: 'canvas',
    runId: Number(match[1]),
    nodeId: match[2],
  }
}

export function makeCanvasChatId(runId: number, nodeId: string): string {
  return `canvas:${runId}:${nodeId}`
}

export function isCanvasChatId(chatId: string): boolean {
  return chatId.startsWith('canvas:')
}
