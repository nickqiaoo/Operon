import type { CronjobSchedule, CronjobTask, CronjobUpsertInput } from "@/types/cronjob"

export interface ProviderInfo {
  id: string
  label: string
  logo: string
}

export interface CronjobEditorProject {
  id: number
  workspaces: ReadonlyArray<{ id: number }>
}

interface ResolveCronjobEditorLocationInput {
  projects: ReadonlyArray<CronjobEditorProject>
  initialWorkspaceId?: number
  activeProjectId?: number
  activeWorkspaceId?: number
}

/**
 * Editing follows the task's stored workspace. The active app location is only
 * a fallback for new tasks or for a workspace that no longer exists.
 */
export const resolveCronjobEditorLocation = ({
  projects,
  initialWorkspaceId,
  activeProjectId,
  activeWorkspaceId,
}: ResolveCronjobEditorLocationInput): { projectId?: number; workspaceId?: number } => {
  const taskProject = initialWorkspaceId == null
    ? undefined
    : projects.find((project) =>
        project.workspaces.some((workspace) => workspace.id === initialWorkspaceId)
      )

  if (taskProject && initialWorkspaceId != null) {
    return { projectId: taskProject.id, workspaceId: initialWorkspaceId }
  }

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const activeWorkspaceProject = activeWorkspaceId == null
    ? undefined
    : projects.find((project) =>
        project.workspaces.some((workspace) => workspace.id === activeWorkspaceId)
      )
  const fallbackProject = activeProject ?? activeWorkspaceProject ?? projects[0]
  const fallbackWorkspaceId = activeWorkspaceId != null && fallbackProject?.workspaces.some(
    (workspace) => workspace.id === activeWorkspaceId
  )
    ? activeWorkspaceId
    : fallbackProject?.workspaces[0]?.id

  return {
    projectId: fallbackProject?.id,
    workspaceId: fallbackWorkspaceId,
  }
}

export const WEEKDAYS = [
  { label: "Mo", value: 1 },
  { label: "Tu", value: 2 },
  { label: "We", value: 3 },
  { label: "Th", value: 4 },
  { label: "Fr", value: 5 },
  { label: "Sa", value: 6 },
  { label: "Su", value: 0 },
]

export const DEFAULT_DAYS = [1, 2, 3, 4, 5]

export const parseTimeToMinutes = (value: string) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export const getScheduleValidationError = (
  startTime: string,
  endTime: string,
  repeatWithinDay: boolean
) => {
  const startMinutes = parseTimeToMinutes(startTime)
  if (startMinutes == null) return "Start time must be between 00:00 and 23:59."
  if (!repeatWithinDay) return null

  const endMinutes = parseTimeToMinutes(endTime)
  if (endMinutes == null) return "End time must be between 00:00 and 23:59."
  if (endMinutes <= startMinutes) return "End time must be later than start time."
  return null
}

export const formatDateTime = (value?: number) => {
  if (!value) return "-"
  return new Date(value).toLocaleString()
}

export const describeSchedule = (schedule: CronjobSchedule) => {
  const days = schedule.days.length > 0 ? schedule.days : DEFAULT_DAYS
  const dayLabels = WEEKDAYS.filter((d) => days.includes(d.value)).map((d) => d.label)
  const dayText = dayLabels.length === 7 ? "Every day" : dayLabels.join(" ")
  if (schedule.intervalMinutes != null && schedule.intervalMinutes > 0) {
    const interval = schedule.intervalMinutes % 60 === 0
      ? `${schedule.intervalMinutes / 60}h`
      : `${schedule.intervalMinutes}min`
    return `Every ${interval} ${schedule.time}–${schedule.endTime ?? "23:59"} · ${dayText}`
  }
  return `Daily ${schedule.time} · ${dayText}`
}

export const toUpsertInput = (job: CronjobTask): CronjobUpsertInput => ({
  name: job.name,
  enabled: job.enabled,
  taskType: job.taskType,
  canvasWorkflowId: job.canvasWorkflowId,
  workspaceId: job.workspaceId,
  providerId: job.providerId,
  modelId: job.modelId,
  modeId: job.modeId,
  thinkingLevel: job.thinkingLevel,
  prompt: job.prompt,
  schedule: job.schedule,
})

export const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
