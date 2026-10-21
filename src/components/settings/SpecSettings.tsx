import { useEffect, useState } from "react"
import { FormattedMessage, defineMessages, useIntl, type MessageDescriptor } from "react-intl"
import { AlertCircle, Check, Layers, Loader2, Plus, Save, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { SeatPicker } from "@/components/spec/SeatPicker"
import type { SpecRoleSettings, SpecSeat } from "@shared/spec"

type SingleRole = Exclude<keyof SpecRoleSettings, "candidates">

/** The single-seat roles in the order a spec runs them (candidates sit after the explorer), each with what it does. */
const ROLES: SingleRole[] = ["lead", "explorer", "judge", "builder", "implementer", "reviewer", "coordinator"]

const LABELS = defineMessages({
  lead: { id: "spec.settings.lead", defaultMessage: "Lead" },
  explorer: { id: "spec.settings.explorer", defaultMessage: "Explorer" },
  judge: { id: "spec.settings.judge", defaultMessage: "Judge" },
  builder: { id: "spec.settings.builder", defaultMessage: "Builder check" },
  implementer: { id: "spec.settings.implementer", defaultMessage: "Implementer" },
  reviewer: { id: "spec.settings.reviewer", defaultMessage: "Reviewer" },
  coordinator: { id: "spec.settings.coordinator", defaultMessage: "Coordinator" },
}) satisfies Record<SingleRole, MessageDescriptor>

const HINTS = defineMessages({
  lead: {
    id: "spec.settings.leadHint",
    defaultMessage: "Writes the rubric, merges the candidates into one design, splits it into tickets, consolidates the reviews. Automatic: the agent and model of the chat the spec starts from.",
  },
  explorer: { id: "spec.settings.explorerHint", defaultMessage: "Maps the code the change touches before anyone designs. Reads a lot, decides little: a fast model is enough." },
  judge: { id: "spec.settings.judgeHint", defaultMessage: "Scores the candidates against the lead's rubric. Automatic: a family other than the lead's." },
  builder: { id: "spec.settings.builderHint", defaultMessage: "Reads the design as the person who has to build it, and asks what is unclear." },
  implementer: { id: "spec.settings.implementerHint", defaultMessage: "Builds the tickets. Gate 1 can still give single tickets to another agent." },
  reviewer: {
    id: "spec.settings.reviewerHint",
    defaultMessage: "Reviews every ticket and the whole change. Automatic: a family other than the ticket's implementer, per ticket.",
  },
  coordinator: {
    id: "spec.settings.coordinatorHint",
    defaultMessage: "Works in the background from the start: deals with failed steps and stuck tickets, and asks you before switching an agent. Automatic: the lead's agent.",
  },
}) satisfies Record<SingleRole, MessageDescriptor>

function sameSeat(a: SpecSeat | null | undefined, b: SpecSeat | null | undefined): boolean {
  return (a?.providerId ?? "") === (b?.providerId ?? "") && (a?.modelId ?? "") === (b?.modelId ?? "")
}

function sameSettings(a: SpecRoleSettings, b: SpecRoleSettings): boolean {
  const ca = a.candidates ?? []
  const cb = b.candidates ?? []
  return ROLES.every((role) => sameSeat(a[role], b[role])) && ca.length === cb.length && ca.every((c, i) => sameSeat(c, cb[i]))
}

/**
 * Settings → OperonSpec: which agent and model plays each role of a new spec.
 * Anything left automatic is picked for model diversity, as before; a spec that
 * is already running keeps its own seats (switch them on the spec itself).
 */
export function SpecSettings() {
  const intl = useIntl()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [available, setAvailable] = useState<string[]>([])
  const [saved, setSaved] = useState<SpecRoleSettings>({})
  const [draft, setDraft] = useState<SpecRoleSettings>({})
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const auto = intl.formatMessage({ id: "spec.settings.auto", defaultMessage: "Automatic" })

  useEffect(() => {
    void (async () => {
      try {
        const { roles, available } = await api.specGetRoleSettings()
        setAvailable(available)
        setSaved(roles)
        setDraft(roles)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // An unpicked candidate slot is not a choice: drop it.
      const { roles } = await api.specSaveRoleSettings({ ...draft, candidates: (draft.candidates ?? []).filter((c) => c?.providerId) })
      setSaved(roles)
      setDraft(roles)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const roleField = (role: SingleRole) => (
    <RoleField key={role} label={intl.formatMessage(LABELS[role])} hint={intl.formatMessage(HINTS[role])}>
      <SeatPicker value={draft[role] ?? null} providers={available} autoLabel={auto} onChange={(seat) => setDraft((d) => ({ ...d, [role]: seat }))} />
    </RoleField>
  )

  const candidates = draft.candidates ?? []
  const setCandidate = (i: number, seat: SpecSeat | null) =>
    setDraft((d) => {
      const next = [...(d.candidates ?? [])]
      if (seat) next[i] = seat
      else next.splice(i, 1)
      return { ...d, candidates: next }
    })

  return (
    <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <Layers className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div>
          <div className="mb-1 text-sm font-semibold">
            <FormattedMessage id="spec.settings.title" defaultMessage="Who plays each role" />
          </div>
          <div className="text-xs text-muted-foreground">
            <FormattedMessage
              id="spec.settings.hint"
              defaultMessage="The agent and model each role of a new spec runs on. Automatic picks agents from different model families, so they check each other. Agents you name in the chat when starting a spec still decide the candidates. A running spec keeps its own: switch them on the spec."
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> <FormattedMessage id="common.loading" defaultMessage="Loading…" />
        </div>
      ) : (
        <>
          {ROLES.slice(0, 2).map(roleField)}

          <RoleField
            label={intl.formatMessage({ id: "spec.settings.candidates", defaultMessage: "Design candidates" })}
            hint={intl.formatMessage({
              id: "spec.settings.candidatesHint",
              defaultMessage: "Each writes a design of its own, to be compared. Automatic: two from different families. With one set, an automatic second runs beside it.",
            })}
          >
            <div className="space-y-2">
              {candidates.map((seat, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">{String.fromCharCode(65 + i)}</span>
                  <SeatPicker className="flex-1" value={seat} providers={available} onChange={(next) => next && setCandidate(i, next)} />
                  <Button size="sm" variant="ghost" className="h-8 w-8 shrink-0 p-0" onClick={() => setCandidate(i, null)} aria-label={intl.formatMessage({ id: "spec.settings.removeCandidate", defaultMessage: "Remove" })}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {candidates.length < 4 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 text-xs"
                  disabled={available.length === 0}
                  onClick={() => setDraft((d) => ({ ...d, candidates: [...(d.candidates ?? []), { providerId: available[0] }] }))}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <FormattedMessage id="spec.settings.addCandidate" defaultMessage="Add a candidate" />
                </Button>
              )}
            </div>
          </RoleField>

          {ROLES.slice(2).map(roleField)}

          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => void save()} disabled={saving || sameSettings(draft, saved)}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : justSaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {justSaved ? <FormattedMessage id="common.saved" defaultMessage="Saved" /> : <FormattedMessage id="common.save" defaultMessage="Save" />}
            </Button>
          </div>
        </>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}
    </div>
  )
}

function RoleField({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium">{label}</div>
      {children}
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  )
}
