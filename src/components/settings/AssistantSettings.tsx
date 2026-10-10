import { useEffect, useState } from "react"
import { AlertCircle, Bot, Check, Loader2, Moon, Save } from "lucide-react"
import type { AssistantAgentChoice, AssistantConfig } from "@shared/assistant"
import { api } from "@/lib/api"
import { assistantApi } from "@/lib/assistant-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** The agents the assistant can run on (server: services/assistant/agents.ts). */
const AGENTS: Array<{ id: string; label: string }> = [
  { id: "custom", label: "Operon" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
]

/** Radix Select reserves the empty value; this stands for "the agent's own default". */
const DEFAULT_MODEL = "__default__"

interface ModelOption {
  modelId: string
  name: string
}

const EMPTY: AssistantConfig = {
  main: { providerId: "custom", modelId: "" },
  worker: { providerId: "custom", modelId: "" },
  background: null,
  quietStart: "23:00",
  quietEnd: "08:00",
}

function sameChoice(a: AssistantAgentChoice | null, b: AssistantAgentChoice | null): boolean {
  return (a?.providerId ?? "") === (b?.providerId ?? "") && (a?.modelId ?? "") === (b?.modelId ?? "")
}

/**
 * Settings → Assistant: which agent and model talks to you (the main agent), which one does the
 * work, which one runs the checks nobody watches — and when the heartbeat keeps quiet. Any of
 * them can be operon, Claude Code, Codex or OpenCode, so a subscription the user already has can
 * do the work.
 */
export function AssistantSettings() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [available, setAvailable] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<AssistantConfig>(EMPTY)
  const [draft, setDraft] = useState<AssistantConfig>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const [providers, config] = await Promise.all([api.getProviders(), assistantApi.getConfig()])
        setAvailable(Object.fromEntries(providers.map((p) => [p.id, p.available])))
        setSaved(config)
        setDraft(config)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const agentsDirty = !sameChoice(draft.main, saved.main) || !sameChoice(draft.worker, saved.worker) || !sameChoice(draft.background, saved.background)
  const quietDirty = draft.quietStart !== saved.quietStart || draft.quietEnd !== saved.quietEnd
  const saveButton = (dirty: boolean) => (
    <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => void save()} disabled={!dirty || saving}>
      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : justSaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
      {justSaved ? "Saved" : "Save"}
    </Button>
  )

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = await assistantApi.setConfig(draft)
      setSaved(next)
      setDraft(next)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <Bot className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <div className="mb-1 text-sm font-semibold">Agents</div>
            <div className="text-xs text-muted-foreground">
              Each part of the assistant can run on Operon or on an agent you already use — Claude Code, Codex or
              OpenCode — with your own subscription. Work done on them counts toward that subscription&apos;s limits.
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <AgentField
              label="Conversation"
              hint="Talks to you, remembers things, hands out tasks. A fast model is enough. A change starts a fresh session on your next message; the conversation carries over."
              value={draft.main}
              available={available}
              onChange={(main) => main && setDraft((d) => ({ ...d, main }))}
            />
            <AgentField
              label="Work"
              hint="Does the work: files, apps, the web. Applies to the next task; a task you continue stays on the agent that started it."
              value={draft.worker}
              available={available}
              onChange={(worker) => worker && setDraft((d) => ({ ...d, worker }))}
            />
            <AgentField
              label="Background checks"
              hint="The heartbeat and scheduled tasks, which run with nobody watching — every 30 minutes for the heartbeat."
              value={draft.background}
              available={available}
              sameAsWork
              onChange={(background) => setDraft((d) => ({ ...d, background }))}
            />
            <div className="flex items-center gap-2">{saveButton(agentsDirty)}</div>
          </>
        )}

        {error && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <Moon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <div className="mb-1 text-sm font-semibold">Quiet hours</div>
            <div className="text-xs text-muted-foreground">
              The assistant keeps checking in the background, but during these hours it only speaks up for something
              urgent. Everything else waits until they end.
            </div>
          </div>
        </div>
        {!loading && (
          <>
            <div className="flex items-center gap-2 text-xs">
              <Input
                type="time"
                aria-label="Quiet hours start"
                value={draft.quietStart}
                onChange={(e) => setDraft((d) => ({ ...d, quietStart: e.target.value }))}
                className="h-8 w-28 border-border/50 bg-background/80 text-xs"
              />
              <span className="text-muted-foreground">to</span>
              <Input
                type="time"
                aria-label="Quiet hours end"
                value={draft.quietEnd}
                onChange={(e) => setDraft((d) => ({ ...d, quietEnd: e.target.value }))}
                className="h-8 w-28 border-border/50 bg-background/80 text-xs"
              />
            </div>
            <div className="flex items-center gap-2">{saveButton(quietDirty)}</div>
          </>
        )}
      </div>
    </div>
  )
}

const SAME_AS_WORK = "__same__"

function AgentField({
  label,
  hint,
  value,
  available,
  sameAsWork,
  onChange,
}: {
  label: string
  hint: string
  value: AssistantAgentChoice | null
  available: Record<string, boolean>
  /** Offer "Same as Work" (stored as null). */
  sameAsWork?: boolean
  onChange: (value: AssistantAgentChoice | null) => void
}) {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  const providerId = value?.providerId

  useEffect(() => {
    if (!providerId) return
    let cancelled = false
    setModels(null)
    api
      .getProviderModels(providerId)
      .then((result: { models?: ModelOption[] }) => {
        if (!cancelled) setModels((result?.models ?? []).map((m) => ({ modelId: m.modelId, name: m.name })))
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [providerId])

  const modelId = value?.modelId ?? ""
  // A saved model that is no longer offered still shows, so the user sees why.
  const options = models && modelId && !models.some((m) => m.modelId === modelId) ? [{ modelId, name: `${modelId} (unavailable)` }, ...models] : (models ?? [])
  const defaultLabel = providerId === "custom" ? "First model set up" : "Agent default"

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium">{label}</div>
      <div className="flex flex-wrap gap-2">
        <Select
          value={value ? value.providerId : SAME_AS_WORK}
          onValueChange={(next) => onChange(next === SAME_AS_WORK ? null : { providerId: next, modelId: "" })}
        >
          <SelectTrigger className="h-8 w-[170px] border-border/50 bg-background/80 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sameAsWork && (
              <SelectItem value={SAME_AS_WORK} className="text-xs">
                Same as Work
              </SelectItem>
            )}
            {AGENTS.map((agent) => (
              <SelectItem key={agent.id} value={agent.id} disabled={available[agent.id] === false} className="text-xs">
                {agent.label}
                {available[agent.id] === false ? " (not installed)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {value && (
          <Select value={modelId || DEFAULT_MODEL} onValueChange={(next) => onChange({ providerId: value.providerId, modelId: next === DEFAULT_MODEL ? "" : next })}>
            <SelectTrigger className="h-8 w-full max-w-[320px] border-border/50 bg-background/80 text-xs">
              <SelectValue placeholder={models === null ? "Loading models…" : defaultLabel} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL} className="text-xs">
                {defaultLabel}
              </SelectItem>
              {options.map((m) => (
                <SelectItem key={m.modelId} value={m.modelId} className="text-xs">
                  {m.name === m.modelId ? m.modelId : `${m.name} · ${m.modelId}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  )
}
