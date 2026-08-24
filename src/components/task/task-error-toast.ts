import { toast } from 'sonner'

export function taskErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown error'
}

export function toastTaskError(error: unknown, title = 'Task action failed'): void {
  toast.error(title, { description: taskErrorMessage(error) })
}
