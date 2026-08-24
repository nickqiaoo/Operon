import { useEffect, useState } from "react"
import { useIntl } from "react-intl"
import { XIcon } from "lucide-react"
import type { CanvasWorkflow } from "@/types/canvas-workflow"
import type { CronjobSchedule, CronjobTask, CronjobTaskType, CronjobUpsertInput } from "@/types/cronjob"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorShortcut,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
import { useModelManagement } from "@/components/editor/hooks/useModelManagement"
import {
  WEEKDAYS,
  DEFAULT_DAYS,
  clampNumber,
  getScheduleValidationError,
  resolveCronjobEditorLocation,
  type ProviderInfo,
} from "./cronjobUtils"

interface CronjobEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: ProviderInfo[]
  projects: { id: number; name: string; workspaces: { id: number; name: string; worktreePath: string }[] }[]
  activeProjectId?: number
  activeWorkspaceId?: number
  initial: CronjobTask | null
  onSave: (input: CronjobUpsertInput) => void
}

const CleanInput = (props: React.ComponentProps<typeof Input>) => (
  <Input
    {...props}
    className={cn(
      "bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background focus:border-tint/20 shadow-none transition-all",
      props.className
    )}
  />
)

const CleanTextarea = (props: React.ComponentProps<typeof Textarea>) => (
  <Textarea
    {...props}
    className={cn(
      "bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background focus:border-tint/20 shadow-none transition-all resize-none min-h-[120px]",
      props.className
    )}
  />
)

export function CronjobEditorDialog({
  open,
  onOpenChange,
  providers,
  projects,
  activeProjectId,
  activeWorkspaceId,
  initial,
  onSave,
}: CronjobEditorDialogProps) {
  const initialLocation = resolveCronjobEditorLocation({
    projects,
    initialWorkspaceId: initial?.workspaceId,
    activeProjectId,
    activeWorkspaceId,
  })
  const [name, setName] = useState(initial?.name ?? "")
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [taskType, setTaskType] = useState<CronjobTaskType>(initial?.taskType ?? "chat")
  const [canvasWorkflowId, setCanvasWorkflowId] = useState<number | undefined>(initial?.canvasWorkflowId)
  const [canvasWorkflows, setCanvasWorkflows] = useState<CanvasWorkflow[]>([])
  const [providerId, setProviderId] = useState(initial?.providerId ?? providers[0]?.id ?? "")
  const [prompt, setPrompt] = useState(initial?.prompt ?? "")
  const [dailyTime, setDailyTime] = useState(initial?.schedule.time ?? "09:00")
  const [dailyDays, setDailyDays] = useState<number[]>(initial?.schedule.days.length ? initial.schedule.days : DEFAULT_DAYS)
  const [dailyRepeat, setDailyRepeat] = useState(initial?.schedule.intervalMinutes != null)
  const [dailyIntervalMinutes, setDailyIntervalMinutes] = useState(initial?.schedule.intervalMinutes ?? 60)
  const [dailyEndTime, setDailyEndTime] = useState(initial?.schedule.endTime ?? "23:59")
  const [projectId, setProjectId] = useState<number | undefined>(initialLocation.projectId)
  const [workspaceId, setWorkspaceId] = useState<number | undefined>(initialLocation.workspaceId)

  const intl = useIntl()
  const modelManagement = useModelManagement(initial?.modelId ?? "", providerId || undefined)
  const { model, setModel, availableModels, selectedModel, modeOptions, currentMode, setMode, thinkingEffortOptions } = modelManagement

  const [thinkingLevel, setThinkingLevel] = useState<string>(initial?.thinkingLevel ?? "")

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? "")
    setEnabled(initial?.enabled ?? true)
    setTaskType(initial?.taskType ?? "chat")
    setCanvasWorkflowId(initial?.canvasWorkflowId)
    setProviderId(initial?.providerId ?? providers[0]?.id ?? "")
    setPrompt(initial?.prompt ?? "")
    setDailyTime(initial?.schedule.time ?? "09:00")
    setDailyDays(initial?.schedule.days.length ? initial.schedule.days : DEFAULT_DAYS)
    setDailyRepeat(initial?.schedule.intervalMinutes != null)
    setDailyIntervalMinutes(initial?.schedule.intervalMinutes ?? 60)
    setDailyEndTime(initial?.schedule.endTime ?? "23:59")
    setThinkingLevel(initial?.thinkingLevel ?? "")
    const location = resolveCronjobEditorLocation({
      projects,
      initialWorkspaceId: initial?.workspaceId,
      activeProjectId,
      activeWorkspaceId,
    })
    setProjectId(location.projectId)
    setWorkspaceId(location.workspaceId)
    api.canvasWorkflowList().then((res) => setCanvasWorkflows(res.workflows)).catch(() => {})
  }, [initial, open, providers, activeProjectId, activeWorkspaceId, projects])

  useEffect(() => { if (initial?.modelId) setModel(initial.modelId) }, [initial?.modelId, setModel])
  useEffect(() => { if (initial?.modeId) setMode(initial.modeId) }, [initial?.modeId, setMode])

  const selectedProject = projects.find((project) => project.id === projectId)
  const workspaces = selectedProject?.workspaces ?? []
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId)

  useEffect(() => {
    if (!selectedProject) return
    if (workspaceId == null || !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setWorkspaceId(workspaces[0]?.id)
    }
  }, [selectedProject, workspaces, workspaceId])

  useEffect(() => {
    if (thinkingEffortOptions.length === 0) return
    if (thinkingLevel && thinkingEffortOptions.some((opt) => opt.value === thinkingLevel)) return
    setThinkingLevel(thinkingEffortOptions[0]?.value ?? "")
  }, [thinkingEffortOptions, thinkingLevel])

  const scheduleError = getScheduleValidationError(dailyTime, dailyEndTime, dailyRepeat)
  const isSubmitDisabled = Boolean(scheduleError) || (
    taskType === "chat" ? (!prompt.trim() || !providerId || !selectedWorkspace?.worktreePath) : canvasWorkflowId == null
  )

  const handleToggleDay = (day: number) => {
    setDailyDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day])
  }

  const handleSubmit = () => {
    const schedule: CronjobSchedule = {
      type: "daily",
      time: dailyTime,
      days: dailyDays.length ? dailyDays : DEFAULT_DAYS,
      ...(dailyRepeat ? { intervalMinutes: clampNumber(dailyIntervalMinutes, 1, 1440), endTime: dailyEndTime } : {}),
    }

    onSave({
      name: name.trim() || intl.formatMessage({ id: "cronjob.editor.defaultName", defaultMessage: "Schedule" }),
      enabled,
      taskType,
      canvasWorkflowId: taskType === "canvas-workflow" ? canvasWorkflowId : undefined,
      workspaceId: taskType === "chat" ? workspaceId : undefined,
      providerId: taskType === "chat" ? (providerId || selectedModel?.providerId || "") : undefined,
      modelId: taskType === "chat" ? (model || undefined) : undefined,
      modeId: taskType === "chat" ? (currentMode || undefined) : undefined,
      thinkingLevel: taskType === "chat" ? (thinkingLevel || undefined) : undefined,
      prompt: taskType === "chat" ? prompt.trim() : undefined,
      schedule,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-2xl overflow-hidden flex flex-col"
        showCloseButton={false}
      >
        <DialogHeader className="px-1 pt-1 pb-4 flex flex-row items-center justify-between shrink-0">
          <DialogTitle className="text-xl font-semibold tracking-tight">
            {initial
              ? intl.formatMessage({ id: "cronjob.editor.editTitle", defaultMessage: "Edit Schedule" })
              : intl.formatMessage({ id: "cronjob.editor.newTitle", defaultMessage: "New Schedule" })}
          </DialogTitle>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50 transition-colors" onClick={() => onOpenChange(false)}>
            <XIcon className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 code-scrollbar">
          <div className="space-y-6 pb-2">
            {/* Task Type Toggle */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.taskType", defaultMessage: "Task Type" })}</label>
              <div className="flex bg-muted/50 rounded-lg p-0.5 w-fit">
                <button type="button" onClick={() => setTaskType("chat")} className={cn("px-4 py-1.5 text-xs font-medium rounded-md transition-all", taskType === "chat" ? "bg-popover shadow-card text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {intl.formatMessage({ id: "cronjob.editor.taskType.chat", defaultMessage: "Chat" })}
                </button>
                <button type="button" onClick={() => setTaskType("canvas-workflow")} className={cn("px-4 py-1.5 text-xs font-medium rounded-md transition-all", taskType === "canvas-workflow" ? "bg-popover shadow-card text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {intl.formatMessage({ id: "cronjob.editor.taskType.workflow", defaultMessage: "Workflow" })}
                </button>
              </div>
            </div>

            {/* Basic Info */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.name", defaultMessage: "Name" })}</label>
                <CleanInput value={name} onChange={(e) => setName(e.target.value)} placeholder={intl.formatMessage({ id: "cronjob.editor.namePlaceholder", defaultMessage: "Daily summary" })} />
              </div>
              {taskType === "chat" ? (
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.adapter", defaultMessage: "Adapter" })}</label>
                  <Select value={providerId} onValueChange={setProviderId}>
                    <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                      <SelectValue placeholder={intl.formatMessage({ id: "cronjob.editor.adapterPlaceholder", defaultMessage: "Select adapter" })} />
                    </SelectTrigger>
                    <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                      {providers.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.workflowLabel", defaultMessage: "Workflow" })}</label>
                  <Select value={canvasWorkflowId != null ? String(canvasWorkflowId) : ""} onValueChange={(v) => setCanvasWorkflowId(Number(v))}>
                    <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                      <SelectValue placeholder={canvasWorkflows.length ? intl.formatMessage({ id: "cronjob.editor.workflowPlaceholder", defaultMessage: "Select workflow" }) : intl.formatMessage({ id: "cronjob.editor.workflowEmpty", defaultMessage: "No workflows" })} />
                    </SelectTrigger>
                    <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                      {canvasWorkflows.map((wf) => (
                        <SelectItem key={wf.id} value={String(wf.id)}>{wf.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Project & Workspace */}
            {taskType === "chat" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.project", defaultMessage: "Project" })}</label>
                  <Select value={projectId != null ? String(projectId) : ""} onValueChange={(v) => setProjectId(Number(v))}>
                    <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                      <SelectValue placeholder={intl.formatMessage({ id: "cronjob.editor.projectPlaceholder", defaultMessage: "Select project" })} />
                    </SelectTrigger>
                    <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={String(project.id)}>{project.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.workspace", defaultMessage: "Workspace" })}</label>
                  <Select value={workspaceId != null ? String(workspaceId) : ""} onValueChange={(v) => setWorkspaceId(Number(v))}>
                    <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                      <SelectValue placeholder={workspaces.length ? intl.formatMessage({ id: "cronjob.editor.workspacePlaceholder", defaultMessage: "Select workspace" }) : intl.formatMessage({ id: "cronjob.editor.workspaceEmpty", defaultMessage: "No workspaces" })} />
                    </SelectTrigger>
                    <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={String(workspace.id)}>{workspace.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <Separator className="bg-border/40" />

            {taskType === "chat" && (
              <>
                {/* Prompt */}
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.prompt", defaultMessage: "Prompt" })}</label>
                  <CleanTextarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={intl.formatMessage({ id: "cronjob.editor.promptPlaceholder", defaultMessage: "Write the prompt for this schedule..." })} />
                </div>

                {/* Model Configuration */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  <div className="space-y-1.5 md:col-span-2">
                    <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.model", defaultMessage: "Model" })}</label>
                    <ModelSelector>
                      <ModelSelectorTrigger asChild>
                        <Button variant="outline" className="w-full justify-between text-muted-foreground bg-muted/30 border-transparent hover:bg-muted/50 shadow-none font-normal h-10 px-3">
                          <span className="flex items-center gap-2">
                            <ModelSelectorLogo provider={selectedModel?.provider ?? ""} className="size-4" />
                            <span className="truncate">{selectedModel?.label ?? intl.formatMessage({ id: "cronjob.editor.modelSelect", defaultMessage: "Select model" })}</span>
                          </span>
                          <span className="text-xs opacity-50">{intl.formatMessage({ id: "cronjob.editor.modelChange", defaultMessage: "Change" })}</span>
                        </Button>
                      </ModelSelectorTrigger>
                      <ModelSelectorContent className="z-[80]">
                        <ModelSelectorInput placeholder={intl.formatMessage({ id: "cronjob.editor.modelSearch", defaultMessage: "Search models..." })} />
                        <ModelSelectorList>
                          {Object.entries(
                            availableModels.reduce<Record<string, typeof availableModels>>((groups, item) => {
                              (groups[item.group] ??= []).push(item)
                              return groups
                            }, {})
                          ).map(([group, items]) => (
                            <ModelSelectorGroup key={group} heading={group}>
                              {items.map((item) => (
                                <ModelSelectorItem key={item.id} value={`${item.label} ${item.id}`} onSelect={() => setModel(item.id)}>
                                  <ModelSelectorLogo provider={item.provider} />
                                  <ModelSelectorName>{item.label}</ModelSelectorName>
                                  {model === item.id && <ModelSelectorShortcut>{intl.formatMessage({ id: "cronjob.editor.modelCurrent", defaultMessage: "current" })}</ModelSelectorShortcut>}
                                </ModelSelectorItem>
                              ))}
                            </ModelSelectorGroup>
                          ))}
                        </ModelSelectorList>
                      </ModelSelectorContent>
                    </ModelSelector>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.mode", defaultMessage: "Mode" })}</label>
                    <Select value={currentMode} onValueChange={setMode}>
                      <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                        <SelectValue placeholder={intl.formatMessage({ id: "cronjob.editor.modeSelect", defaultMessage: "Select mode" })} />
                      </SelectTrigger>
                      <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                        {modeOptions.map((mode) => (
                          <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {thinkingEffortOptions.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.editor.thinkingLevel", defaultMessage: "Thinking Level" })}</label>
                    <Select value={thinkingLevel} onValueChange={setThinkingLevel}>
                      <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                        <SelectValue placeholder={intl.formatMessage({ id: "cronjob.editor.thinkingLevelSelect", defaultMessage: "Select thinking level" })} />
                      </SelectTrigger>
                      <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                        {thinkingEffortOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}

            {/* Schedule Section */}
            <div className="bg-muted/20 rounded-xl p-1">
              <div className="bg-background rounded-lg border border-border/40 p-4 space-y-4 shadow-card">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70">{intl.formatMessage({ id: "cronjob.editor.runSchedule", defaultMessage: "Run Schedule" })}</label>

                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <CleanInput
                      type="time"
                      value={dailyTime}
                      min="00:00"
                      max="23:59"
                      aria-invalid={scheduleError ? "true" : "false"}
                      onChange={(e) => setDailyTime(e.target.value)}
                      className="w-32 font-mono text-center bg-muted/20"
                    />
                    <div className="text-xs text-muted-foreground">{dailyRepeat ? intl.formatMessage({ id: "cronjob.editor.startTime", defaultMessage: "Start time" }) : intl.formatMessage({ id: "cronjob.editor.runTime", defaultMessage: "Run time" })}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((day) => {
                      const active = dailyDays.includes(day.value)
                      return (
                        <button
                          key={day.value}
                          type="button"
                          className={cn(
                            "h-8 w-8 rounded-full text-xs font-medium transition-all flex items-center justify-center",
                            active ? "bg-tint text-tint-fg shadow-card" : "bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          )}
                          onClick={() => handleToggleDay(day.value)}
                        >
                          {day.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div className="text-xs text-muted-foreground">{intl.formatMessage({ id: "cronjob.editor.repeatWithinDay", defaultMessage: "Repeat within day" })}</div>
                    <Switch checked={dailyRepeat} onCheckedChange={setDailyRepeat} />
                  </div>
                  {dailyRepeat && (
                    <div className="flex items-center gap-3 pl-1">
                      <span className="text-xs text-muted-foreground shrink-0">{intl.formatMessage({ id: "cronjob.editor.every", defaultMessage: "Every" })}</span>
                      <CleanInput type="number" value={dailyIntervalMinutes} min={1} max={1440} onChange={(e) => setDailyIntervalMinutes(Number(e.target.value))} className="max-w-[80px]" />
                      <span className="text-xs text-muted-foreground shrink-0">{intl.formatMessage({ id: "cronjob.editor.minUntil", defaultMessage: "min, until" })}</span>
                      <CleanInput
                        type="time"
                        value={dailyEndTime}
                        min="00:00"
                        max="23:59"
                        aria-invalid={scheduleError ? "true" : "false"}
                        onChange={(e) => setDailyEndTime(e.target.value)}
                        className="w-32 font-mono text-center bg-muted/20"
                      />
                    </div>
                  )}
                  {scheduleError && (
                    <div className="text-xs text-destructive pl-1">{scheduleError}</div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between py-2 px-1">
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{intl.formatMessage({ id: "cronjob.editor.enabled", defaultMessage: "Enabled" })}</div>
                <div className="text-xs text-muted-foreground">{intl.formatMessage({ id: "cronjob.editor.enabledDesc", defaultMessage: "Job will run according to schedule" })}</div>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
        </div>

        <DialogFooter className="pt-4 mt-4 border-t border-border/40 shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="hover:bg-muted/50">{intl.formatMessage({ id: "common.cancel", defaultMessage: "Cancel" })}</Button>
          <Button
            variant="secondary"
            onClick={handleSubmit}
            disabled={isSubmitDisabled}
            className="px-6"
          >
            {initial ? intl.formatMessage({ id: "cronjob.editor.saveChanges", defaultMessage: "Save Changes" }) : intl.formatMessage({ id: "cronjob.editor.createJob", defaultMessage: "Create Job" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
