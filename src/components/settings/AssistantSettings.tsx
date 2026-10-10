import { useEffect, useState } from "react"
import { AlertCircle, Check, Loader2, MessageCircle, Moon, Save } from "lucide-react"
import type { AssistantConfig } from "@shared/assistant"
import { api } from "@/lib/api"
import { assistantApi } from "@/lib/assistant-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface ModelOption {
  modelId: string
  name: string
}

/** The operon runtime's models: `provider/model` ids from every configured provider. */
async function loadOperonModels(): Promise<ModelOption[]> {
  const result = (await api.getProviderModels("custom")) as { models?: Array<{ modelId: string; name: string }> }
  return (result?.models ?? []).map((m) => ({ modelId: m.modelId, name: m.name }))
}

const EMPTY: AssistantConfig = { mainModel: "", workerModel: "", quietStart: "23:00", quietEnd: "08:00" }

/**
 * Settings → Assistant: which model talks (main agent) and which one works (workers), and
 * when the heartbeat keeps quiet. The main agent only chats and dispatches, so a fast model
 * is enough; workers do the tool work and benefit from a stronger one.
 */
export function AssistantSettings() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [saved, setSaved] = useState<AssistantConfig>(EMPTY)
  const [draft, setDraft] = useState<AssistantConfig>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const [list, config] = await Promise.all([loadOperonModels(), assistantApi.getConfig()])
        setModels(list)
        setSaved(config)
        setDraft(config)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const modelsDirty = draft.mainModel !== saved.mainModel || draft.workerModel !== saved.workerModel
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
          <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <div className="mb-1 text-sm font-semibold">Models</div>
            <div className="text-xs text-muted-foreground">
              The assistant uses two models: one that talks to you and hands out work, and one that does the work in
              the background. A fast model is enough for the first; the second benefits from a stronger one.
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : models.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> No models available. Add a provider in AI Providers first.
          </div>
        ) : (
          <>
            <ModelField
              label="Conversation model"
              hint="Talks to you, remembers things, hands out tasks."
              value={draft.mainModel}
              models={models}
              onChange={(mainModel) => setDraft((d) => ({ ...d, mainModel }))}
            />
            <ModelField
              label="Worker model"
              hint="Does the work: files, apps, the web. Applies to the next task it starts."
              value={draft.workerModel}
              models={models}
              onChange={(workerModel) => setDraft((d) => ({ ...d, workerModel }))}
            />
            <div className="flex items-center gap-2">{saveButton(modelsDirty)}</div>
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

function ModelField({
  label,
  hint,
  value,
  models,
  onChange,
}: {
  label: string
  hint: string
  value: string
  models: ModelOption[]
  onChange: (modelId: string) => void
}) {
  // A saved model that is no longer offered (provider removed) still shows, so the user sees why.
  const options = value && !models.some((m) => m.modelId === value) ? [{ modelId: value, name: `${value} (unavailable)` }, ...models] : models
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium">{label}</div>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-full max-w-[360px] border-border/50 bg-background/80 text-xs">
          <SelectValue placeholder="Use the first available model" />
        </SelectTrigger>
        <SelectContent>
          {options.map((m) => (
            <SelectItem key={m.modelId} value={m.modelId} className="text-xs">
              {m.name === m.modelId ? m.modelId : `${m.name} · ${m.modelId}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  )
}
