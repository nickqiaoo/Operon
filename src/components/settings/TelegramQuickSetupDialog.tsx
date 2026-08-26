import { useEffect, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  HelpCircle,
  Loader2,
  RefreshCw,
  Send,
  Settings,
  XIcon,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api } from "@/lib/api"
import { openExternalUrl } from "@/lib/open-external"
import type { Agent } from "@/types/channel"
import { FormattedMessage, useIntl } from "react-intl"

type Step = "token" | "configure" | "done"

interface ValidatedBot {
  id: number
  username: string | null
  firstName: string
  canReadAllGroupMessages?: boolean
}

const inputCn =
  "w-full px-3 py-2 text-sm bg-background/80 rounded-xl border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40"
const tokenCn = inputCn + " font-mono pr-10"

export function TelegramQuickSetupDialog({
  open,
  onClose,
  onCreated,
  agents,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  agents: Agent[]
}) {
  const intl = useIntl()
  const [step, setStep] = useState<Step>("token")

  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [validated, setValidated] = useState<ValidatedBot | null>(null)

  const [displayName, setDisplayName] = useState("")
  const [description, setDescription] = useState("")
  const [agentId, setAgentId] = useState<number | null>(null)

  const [createdInfo, setCreatedInfo] = useState<{
    providerId: number
    username: string | null
    canReadAllGroupMessages: boolean
  } | null>(null)
  const [applyWarning, setApplyWarning] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setStep("token")
    setToken("")
    setShowToken(false)
    setValidated(null)
    setDisplayName("")
    setDescription("")
    setAgentId(null)
    setCreatedInfo(null)
    setApplyWarning(null)
    setError(null)
    setBusy(false)
  }, [open])

  async function handleValidate() {
    const t = token.trim()
    if (!t) {
      setError(intl.formatMessage({ id: "settings.telegram.error.tokenRequired", defaultMessage: "Paste a bot token first" }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.imTelegramQuickSetupValidate({ token: t })
      if ("error" in res) {
        setError(res.error)
        return
      }
      setValidated(res.bot)
      setDisplayName(res.bot.firstName)
      setStep("configure")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate() {
    const t = token.trim()
    const name = displayName.trim()
    if (!name) {
      setError(intl.formatMessage({ id: "settings.telegram.error.nameRequired", defaultMessage: "Display name is required" }))
      return
    }
    if (!agentId) {
      setError(intl.formatMessage({ id: "settings.telegram.error.agentRequired", defaultMessage: "Pick an agent" }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.imTelegramQuickSetupCreate({
        token: t,
        displayName: name,
        description: description.trim() || undefined,
        mode: "mate",
        agentId,
      })
      if ("error" in res) {
        setError(res.error)
        return
      }
      setCreatedInfo({
        providerId: res.provider.id,
        username: res.bot.username,
        canReadAllGroupMessages: res.bot.canReadAllGroupMessages === true,
      })
      setApplyWarning(res.applyWarning)
      setStep("done")
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-hidden flex flex-col"
        showCloseButton={false}
      >
        <DialogHeader className="px-1 pt-1 pb-3 flex flex-row items-center justify-between shrink-0">
          <div>
            <DialogTitle className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <Zap className="h-5 w-5 text-tint" />
              <FormattedMessage id="settings.telegram.title" defaultMessage="Telegram Quick Setup" />
            </DialogTitle>
            <p className="text-xs text-muted-foreground/70 mt-1">
              <FormattedMessage id="settings.telegram.subtitle" defaultMessage="Create a bot in BotFather, paste the token — we configure the rest." />
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <Stepper step={step} />

        <div className="min-h-0 overflow-y-auto -mx-6 px-6 code-scrollbar mt-3">
          {step === "token" && (
            <TokenStep
              token={token}
              onTokenChange={setToken}
              showToken={showToken}
              onToggleShow={() => setShowToken((v) => !v)}
            />
          )}
          {step === "configure" && validated && (
            <ConfigureStep
              bot={validated}
              displayName={displayName}
              onDisplayNameChange={setDisplayName}
              description={description}
              onDescriptionChange={setDescription}
              agentId={agentId}
              onAgentChange={setAgentId}
              agents={agents}
            />
          )}
          {step === "done" && createdInfo && (
            <DoneStep
              info={createdInfo}
              displayName={displayName}
              warning={applyWarning}
              onPrivacyRecheck={(updated) => setCreatedInfo({ ...createdInfo, ...updated })}
            />
          )}
        </div>

        {error && (
          <div className="mx-1 mt-3 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        <DialogFooter>
          {step === "token" && (
            <>
              <Button size="sm" variant="ghost" onClick={onClose} className="h-8">
                <FormattedMessage id="settings.telegram.cancel" defaultMessage="Cancel" />
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void handleValidate()} disabled={busy} className="h-8 gap-1.5">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <FormattedMessage id="settings.telegram.validate" defaultMessage="Validate token" />
              </Button>
            </>
          )}
          {step === "configure" && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setStep("token")} className="h-8">
                <FormattedMessage id="settings.telegram.back" defaultMessage="Back" />
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void handleCreate()} disabled={busy} className="h-8 gap-1.5">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <FormattedMessage id="settings.telegram.createProvider" defaultMessage="Create provider" />
              </Button>
            </>
          )}
          {step === "done" && (
            <Button size="sm" variant="secondary" onClick={onClose} className="h-8 gap-1.5">
              <FormattedMessage id="settings.telegram.done" defaultMessage="Done" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stepper({ step }: { step: Step }) {
  const intl = useIntl()
  const steps: Array<{ key: Step; label: string }> = [
    { key: "token", label: intl.formatMessage({ id: "settings.telegram.stepper.token", defaultMessage: "Paste token" }) },
    { key: "configure", label: intl.formatMessage({ id: "settings.telegram.stepper.configure", defaultMessage: "Configure" }) },
    { key: "done", label: intl.formatMessage({ id: "settings.telegram.stepper.done", defaultMessage: "Done" }) },
  ]
  const activeIdx = steps.findIndex((s) => s.key === step)
  return (
    <div className="flex items-center gap-2 px-1">
      {steps.map((s, i) => {
        const reached = i <= activeIdx
        return (
          <div key={s.key} className="flex items-center gap-2 flex-1">
            <div
              className={
                "flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-semibold transition-colors " +
                (reached ? "bg-tint/20 text-tint" : "bg-muted/30 text-muted-foreground/60")
              }
            >
              {i + 1}
            </div>
            <span
              className={
                "text-[11px] uppercase tracking-wider truncate " +
                (reached ? "text-foreground/80" : "text-muted-foreground/50")
              }
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div className={"flex-1 h-px " + (i < activeIdx ? "bg-tint/30" : "bg-border/40")} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function TokenStep({
  token,
  onTokenChange,
  showToken,
  onToggleShow,
}: {
  token: string
  onTokenChange: (v: string) => void
  showToken: boolean
  onToggleShow: () => void
}) {
  const intl = useIntl()
  return (
    <div className="space-y-4 pb-2">
      <div className="rounded-xl border border-border/40 bg-muted/10 p-4 space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          <FormattedMessage
            id="settings.telegram.token.desc"
            defaultMessage="In BotFather, run {cmd}, give it a name and a username, then copy the token back here."
            values={{ cmd: <code className="px-1 py-0.5 rounded bg-muted/40 font-mono text-[11px]">/newbot</code> }}
          />
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => openExternalUrl("https://t.me/BotFather")}
        >
          <Send className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.telegram.token.openBotFather" defaultMessage="Open BotFather" />
          <ExternalLink className="h-3 w-3 opacity-60" />
        </Button>
      </div>

      <Field
        label={intl.formatMessage({ id: "settings.telegram.token.label", defaultMessage: "Bot Token" })}
        hint={intl.formatMessage({ id: "settings.telegram.token.hint", defaultMessage: "Format: 1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ" })}
      >
        <div className="relative">
          <input
            className={tokenCn}
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="1234567890:ABC..."
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={onToggleShow}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </Field>
    </div>
  )
}

function ConfigureStep({
  bot,
  displayName,
  onDisplayNameChange,
  description,
  onDescriptionChange,
  agentId,
  onAgentChange,
  agents,
}: {
  bot: ValidatedBot
  displayName: string
  onDisplayNameChange: (v: string) => void
  description: string
  onDescriptionChange: (v: string) => void
  agentId: number | null
  onAgentChange: (id: number | null) => void
  agents: Agent[]
}) {
  const intl = useIntl()
  return (
    <div className="space-y-4 pb-2">
      <div className="rounded-xl border border-border/40 bg-muted/10 p-4">
        <div className="flex items-center gap-2 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          <span className="text-muted-foreground">
            <FormattedMessage id="settings.telegram.configure.verified" defaultMessage="Token verified." />
          </span>
          {bot.username && (
            <span className="font-mono text-foreground">@{bot.username}</span>
          )}
        </div>
      </div>

      <Field
        label={intl.formatMessage({ id: "settings.telegram.configure.displayName", defaultMessage: "Display Name" })}
        hint={intl.formatMessage({ id: "settings.telegram.configure.displayNameHint", defaultMessage: "Shown in IM and prompts. Pre-filled from the bot's BotFather name — change if you want." })}
      >
        <input
          className={inputCn}
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="Code Writer"
        />
      </Field>

      <Field
        label={intl.formatMessage({ id: "settings.telegram.configure.description", defaultMessage: "Description (optional)" })}
        hint={intl.formatMessage({ id: "settings.telegram.configure.descriptionHint", defaultMessage: "Shown on the bot's Telegram profile." })}
      >
        <textarea
          className={inputCn + " min-h-[60px] resize-y"}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Your AI coding agent in Telegram."
        />
      </Field>

      <Field
        label={intl.formatMessage({ id: "settings.telegram.configure.agent", defaultMessage: "Agent" })}
        hint={intl.formatMessage({ id: "settings.telegram.configure.agentHint", defaultMessage: "The agent this bot embodies." })}
      >
        <Select
          value={agentId != null ? String(agentId) : ""}
          onValueChange={(v) => onAgentChange(v ? Number(v) : null)}
        >
          <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 shadow-none">
            <SelectValue placeholder={agents.length === 0
              ? intl.formatMessage({ id: "settings.telegram.configure.noAgents", defaultMessage: "No agents available" })
              : intl.formatMessage({ id: "settings.telegram.configure.selectAgent", defaultMessage: "Select an agent" })
            } />
          </SelectTrigger>
          <SelectContent className="z-[80]">
            {agents.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name} <span className="text-muted-foreground">· {a.provider}/{a.model}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {bot.canReadAllGroupMessages === false && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-amber-600 dark:text-amber-400 mb-1">
            <FormattedMessage id="settings.telegram.configure.privacyWarning.title" defaultMessage="Heads up: group privacy is on" />
          </p>
          <p>
            <FormattedMessage
              id="settings.telegram.configure.privacyWarning.desc"
              defaultMessage="This bot only sees commands and @-mentions in groups. For full group co-pilot mode, add it as {admin} after creation — admins bypass privacy mode."
              values={{ admin: <span className="font-medium">admin</span> }}
            />
          </p>
        </div>
      )}
    </div>
  )
}

function DoneStep({
  info,
  displayName,
  warning,
  onPrivacyRecheck,
}: {
  info: { providerId: number; username: string | null; canReadAllGroupMessages: boolean }
  displayName: string
  warning: string | null
  onPrivacyRecheck: (updated: { canReadAllGroupMessages: boolean }) => void
}) {
  const intl = useIntl()
  const { providerId, username, canReadAllGroupMessages } = info
  const [rechecking, setRechecking] = useState(false)
  const [recheckError, setRecheckError] = useState<string | null>(null)
  const [b2bAcked, setB2bAcked] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleRecheck() {
    setRechecking(true)
    setRecheckError(null)
    try {
      const res = await api.imTelegramQuickSetupRecheck(providerId)
      if ("error" in res) {
        setRecheckError(res.error)
        return
      }
      onPrivacyRecheck({ canReadAllGroupMessages: res.bot.canReadAllGroupMessages === true })
    } catch (err) {
      setRecheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setRechecking(false)
    }
  }

  async function handleOpenBotFather() {
    if (username) {
      try {
        await navigator.clipboard.writeText(`@${username}`)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        // Clipboard may be unavailable; ignore — BotFather still opens.
      }
    }
    openExternalUrl("https://t.me/BotFather")
  }

  return (
    <div className="space-y-4 pb-2">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <span>
            <FormattedMessage id="settings.telegram.done.readyTitle" defaultMessage="{name} is ready" values={{ name: displayName }} />
          </span>
        </div>
        {username && (
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.telegram.done.live"
              defaultMessage="Your bot is live at {username}."
              values={{ username: <span className="font-mono text-foreground">@{username}</span> }}
            />
          </p>
        )}
      </div>

      {username && (
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 justify-start"
            onClick={() => openExternalUrl(`https://t.me/${username}`)}
          >
            <Send className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.telegram.done.openTelegram" defaultMessage="Open in Telegram" />
            <ExternalLink className="h-3 w-3 opacity-60" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 justify-start"
            onClick={() => openExternalUrl(`https://t.me/${username}?startgroup=true`)}
          >
            <Send className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.telegram.done.addToGroup" defaultMessage="Add to a group" />
            <ExternalLink className="h-3 w-3 opacity-60" />
          </Button>
        </div>
      )}

      <div className="rounded-xl border border-border/40 bg-muted/10 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Settings className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold mb-1">
              <FormattedMessage id="settings.telegram.done.copilot.title" defaultMessage="Group co-pilot mode" />
            </p>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage id="settings.telegram.done.copilot.desc" defaultMessage="For multi-agent group conversations, two BotFather-only settings need a manual flip. Telegram doesn't expose API methods for either." />
            </p>
          </div>
        </div>

        <div className="space-y-2 pl-8">
          <ChecklistRow
            status={canReadAllGroupMessages ? "ok" : "warn"}
            title={intl.formatMessage({ id: "settings.telegram.done.privacy.title", defaultMessage: "Privacy Mode: OFF" })}
            detail={intl.formatMessage({
              id: canReadAllGroupMessages ? "settings.telegram.done.privacy.ok" : "settings.telegram.done.privacy.warn",
              defaultMessage: canReadAllGroupMessages
                ? "Bot can read all group messages."
                : "Bot can only see commands and @mentions. Turn OFF in BotFather, or promote to admin (admins bypass privacy).",
            })}
            action={
              canReadAllGroupMessages ? undefined : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleRecheck()}
                  disabled={rechecking}
                  className="h-7 gap-1.5 text-xs"
                >
                  {rechecking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  <FormattedMessage id="settings.telegram.done.recheck" defaultMessage="Re-check" />
                </Button>
              )
            }
          />

          <ChecklistRow
            status={b2bAcked ? "ok" : "unknown"}
            title={intl.formatMessage({ id: "settings.telegram.done.b2b.title", defaultMessage: "Bot-to-Bot Communication: ON" })}
            detail={intl.formatMessage({
              id: b2bAcked ? "settings.telegram.done.b2b.done" : "settings.telegram.done.b2b.desc",
              defaultMessage: b2bAcked
                ? "Marked as done — Telegram cannot verify this via API."
                : "Lets your bot see messages from other bots in the same group. API can't detect this — confirm manually after flipping it in BotFather.",
            })}
            action={
              b2bAcked ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setB2bAcked(false)}
                  className="h-7 gap-1.5 text-xs"
                >
                  <FormattedMessage id="settings.telegram.done.b2b.undo" defaultMessage="Undo" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setB2bAcked(true)}
                  className="h-7 gap-1.5 text-xs"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <FormattedMessage id="settings.telegram.done.b2b.markDone" defaultMessage="Mark done" />
                </Button>
              )
            }
          />
        </div>

        <div className="pl-8 space-y-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleOpenBotFather()}
            className="h-8 gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.telegram.done.openBotFather" defaultMessage="Open BotFather" />
            {copied && (
              <span className="text-[11px] text-emerald-500 ml-1">
                <FormattedMessage id="settings.telegram.done.copied" defaultMessage="@{username} copied" values={{ username }} />
              </span>
            )}
          </Button>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground flex items-center gap-1">
              <HelpCircle className="h-3 w-3" />
              <FormattedMessage id="settings.telegram.done.howToFlip" defaultMessage="How to flip these in BotFather" />
            </summary>
            <ol className="list-decimal list-inside mt-2 space-y-1 text-[11px] leading-relaxed">
              <li>
                <FormattedMessage
                  id="settings.telegram.done.howTo.step1"
                  defaultMessage="Send {cmd}"
                  values={{ cmd: <code className="px-1 py-0.5 rounded bg-muted/40 font-mono">/mybots</code> }}
                />
              </li>
              <li>
                {username
                  ? <FormattedMessage id="settings.telegram.done.howTo.step2" defaultMessage="Pick {bot}" values={{ bot: <span className="font-mono">@{username}</span> }} />
                  : <FormattedMessage id="settings.telegram.done.howTo.step2Generic" defaultMessage="Pick your bot" />
                }
              </li>
              <li>
                <FormattedMessage
                  id="settings.telegram.done.howTo.step3"
                  defaultMessage="Bot Settings → Group Privacy → {turnOff}"
                  values={{ turnOff: <span className="font-medium">Turn off</span> }}
                />
              </li>
              <li>
                <FormattedMessage
                  id="settings.telegram.done.howTo.step4"
                  defaultMessage="Bot Settings → Bot-to-Bot Communication Mode → {turnOn}"
                  values={{ turnOn: <span className="font-medium">Turn on</span> }}
                />
              </li>
              <li>
                <FormattedMessage id="settings.telegram.done.howTo.step5" defaultMessage="Come back and click Re-check / Mark done above" />
              </li>
            </ol>
          </details>
        </div>
      </div>

      {recheckError && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
          {recheckError}
        </div>
      )}

      {warning && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-xs">
          <p className="font-medium text-amber-600 dark:text-amber-400 mb-1">
            <FormattedMessage id="settings.telegram.done.applyWarning.title" defaultMessage="Some default settings didn't apply" />
          </p>
          <p className="text-muted-foreground">{warning}</p>
          <p className="text-muted-foreground mt-1">
            <FormattedMessage id="settings.telegram.done.applyWarning.desc" defaultMessage="The bot still works — you can re-run setup in BotFather manually." />
          </p>
        </div>
      )}
    </div>
  )
}

function ChecklistRow({
  status,
  title,
  detail,
  action,
}: {
  status: "ok" | "warn" | "unknown"
  title: string
  detail: string
  action?: React.ReactNode
}) {
  const icon =
    status === "ok" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
    ) : status === "warn" ? (
      <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
    ) : (
      <HelpCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
    )
  return (
    <div className="flex items-start gap-2 rounded-lg bg-background/40 border border-border/40 p-3">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{detail}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground/60">{hint}</p>}
    </div>
  )
}
