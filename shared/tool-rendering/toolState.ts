export type SharedToolState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied'

const TOOL_UI_STATES: SharedToolState[] = [
  'input-streaming',
  'input-available',
  'approval-requested',
  'approval-responded',
  'output-available',
  'output-error',
  'output-denied',
]

const isToolUIState = (value: string): value is SharedToolState =>
  TOOL_UI_STATES.includes(value as SharedToolState)

export const normalizeToolState = (state?: string): SharedToolState => {
  if (!state) return 'input-available'
  if (state === 'partial-call') return 'input-streaming'
  if (state === 'call') return 'input-available'
  if (state === 'result') return 'output-available'
  if (isToolUIState(state)) return state
  return 'input-available'
}
