import { useEffect, useState } from "react"
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  XIcon,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
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
import type { IMProviderCreateInput } from "@/types/im"
import { FormattedMessage, useIntl } from "react-intl"

type Step = "name" | "manifest" | "install"

const SLACK_APPS_URL = "https://api.slack.com/apps"
const SLACK_NEW_APP_URL = "https://api.slack.com/apps?new_app=1"

const inputCn =
  "w-full px-3 py-2 text-sm bg-background/80 rounded-xl border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40"
const tokenCn = inputCn + " font-mono pr-10"

export function SlackQuickSetupDialog({
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
  const [step, setStep] = useState<Step>("name")

  const [displayName, setDisplayName] = useState("")
  const [agentId, setAgentId] = useState<number | null>(null)

  const [manifest, setManifest] = useState("")
  const [botToken, setBotToken] = useState("")
  const [appToken, setAppToken] = useState("")
  const [showBot, setShowBot] = useState(false)
  const [showApp, setShowApp] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    setStep("name")
    setDisplayName("")
    setAgentId(null)
    setManifest("")
    setBotToken("")
    setAppToken("")
    setShowBot(false)
    setShowApp(false)
  }, [open])

  async function handleBuildManifest() {
    const name = displayName.trim()
    if (!name) {
      setError(intl.formatMessage({ id: "settings.slack.error.nameRequired", defaultMessage: "Display name is required" }))
      return
    }
    if (!agentId) {
      setError(intl.formatMessage({ id: "settings.slack.error.agentRequired", defaultMessage: "Pick an agent" }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.imSlackQuickSetupManifest({ displayName: name })
      if ("error" in res) {
        setError(res.error)
        return
      }
      setManifest(res.manifest)
      setStep("manifest")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleFinish() {
    const bt = botToken.trim()
    const at = appToken.trim()
    if (!bt || !at) {
      setError(intl.formatMessage({ id: "settings.slack.error.tokensRequired", defaultMessage: "Both tokens are required" }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload: Omit<IMProviderCreateInput, "instanceId" | "selfUserId"> = {
        source: "slack",
        mode: "mate",
        agentId,
        displayName: displayName.trim(),
        credentialsJson: JSON.stringify({ botToken: bt, appToken: at }),
        enabled: true,
      }
      await api.imProviderCreate(payload as IMProviderCreateInput)
      onCreated()
      onClose()
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
              <FormattedMessage id="settings.slack.title" defaultMessage="Slack Quick Setup" />
            </DialogTitle>
            <p className="text-xs text-muted-foreground/70 mt-1">
              <FormattedMessage
                id="settings.slack.subtitle"
                defaultMessage="Operon generates the app manifest; you create the app in Slack and paste two tokens back."
              />
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <Stepper step={step} />

        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 code-scrollbar mt-3">
          {step === "name" && (
            <NameStep
              displayName={displayName}
              onDisplayNameChange={setDisplayName}
              agentId={agentId}
              onAgentChange={setAgentId}
              agents={agents}
            />
          )}
          {step === "manifest" && (
            <ManifestStep manifest={manifest} />
          )}
          {step === "install" && (
            <InstallStep
              botToken={botToken}
              appToken={appToken}
              onBotChange={setBotToken}
              onAppChange={setAppToken}
              showBot={showBot}
              showApp={showApp}
              onToggleBot={() => setShowBot((v) => !v)}
              onToggleApp={() => setShowApp((v) => !v)}
            />
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive mt-4">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="pt-4 mt-4 border-t border-border/40 shrink-0 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} className="hover:bg-muted/50">
            <FormattedMessage id="settings.slack.cancel" defaultMessage="Cancel" />
          </Button>
          {step === "manifest" && (
            <Button variant="ghost" onClick={() => setStep("name")} className="hover:bg-muted/50">
              <FormattedMessage id="settings.slack.back" defaultMessage="Back" />
            </Button>
          )}
          {step === "install" && (
            <Button variant="ghost" onClick={() => setStep("manifest")} className="hover:bg-muted/50">
              <FormattedMessage id="settings.slack.back" defaultMessage="Back" />
            </Button>
          )}
          {step === "name" && (
            <Button variant="secondary" disabled={busy} onClick={() => void handleBuildManifest()} className="px-6">
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              <FormattedMessage id="settings.slack.generateManifest" defaultMessage="Generate Manifest" />
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          )}
          {step === "manifest" && (
            <Button variant="secondary" onClick={() => setStep("install")} className="px-6">
              <FormattedMessage id="settings.slack.appCreatedNext" defaultMessage="I created the app" />
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          )}
          {step === "install" && (
            <Button variant="secondary" disabled={busy} onClick={() => void handleFinish()} className="px-6">
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              <FormattedMessage id="settings.slack.finish" defaultMessage="Finish" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Stepper({ step }: { step: Step }) {
  const intl = useIntl()
  const items: { key: Step; label: string }[] = [
    { key: "name", label: intl.formatMessage({ id: "settings.slack.stepper.name", defaultMessage: "Name your bot" }) },
    { key: "manifest", label: intl.formatMessage({ id: "settings.slack.stepper.manifest", defaultMessage: "Create app in Slack" }) },
    { key: "install", label: intl.formatMessage({ id: "settings.slack.stepper.install", defaultMessage: "Install & paste tokens" }) },
  ]
  const order: Step[] = ["name", "manifest", "install"]
  const currentIdx = order.indexOf(step)
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 px-1">
      {items.map((item, idx) => {
        const isCurrent = item.key === step
        const isDone = idx < currentIdx
        return (
          <div key={item.key} className="flex items-center gap-2">
            <div
              className={
                "h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-semibold " +
                (isDone
                  ? "bg-tint/20 text-tint"
                  : isCurrent
                    ? "bg-tint/15 text-tint ring-1 ring-tint/40"
                    : "bg-muted/40 text-muted-foreground")
              }
            >
              {idx + 1}
            </div>
            <span className={isCurrent ? "text-foreground font-medium" : ""}>{item.label}</span>
            {idx < items.length - 1 && <span className="text-muted-foreground/40">›</span>}
          </div>
        )
      })}
    </div>
  )
}

function NameStep({
  displayName,
  onDisplayNameChange,
  agentId,
  onAgentChange,
  agents,
}: {
  displayName: string
  onDisplayNameChange: (v: string) => void
  agentId: number | null
  onAgentChange: (v: number | null) => void
  agents: Agent[]
}) {
  const intl = useIntl()
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/40 bg-muted/10 p-4 text-xs text-muted-foreground flex items-start gap-3">
        <CheckCircle2 className="h-4 w-4 text-tint mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="text-foreground font-medium">
            <FormattedMessage id="settings.slack.name.title" defaultMessage="How this works" />
          </p>
          <p className="mt-0.5">
            <FormattedMessage
              id="settings.slack.name.howItWorks"
              defaultMessage="Operon builds an app manifest with the right scopes, events and Socket Mode already set. You paste it into Slack's {fromManifest} flow — no extra credentials needed."
              values={{ fromManifest: <span className="font-medium">From a manifest</span> }}
            />
          </p>
        </div>
      </div>

      <FieldLabel
        label={intl.formatMessage({ id: "settings.slack.name.appName", defaultMessage: "App Name" })}
        hint={intl.formatMessage({ id: "settings.slack.name.appNameHint", defaultMessage: "Shown in Slack as the bot's display name. Max 35 chars." })}
      >
        <input
          className={inputCn}
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="Code Writer"
          spellCheck={false}
          autoComplete="off"
        />
      </FieldLabel>
      <FieldLabel
        label={intl.formatMessage({ id: "settings.slack.name.agent", defaultMessage: "Agent" })}
        hint={intl.formatMessage({ id: "settings.slack.name.agentHint", defaultMessage: "The agent this bot embodies in mate mode." })}
      >
        <Select
          value={agentId != null ? String(agentId) : ""}
          onValueChange={(v) => onAgentChange(v ? Number(v) : null)}
        >
          <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 shadow-none">
            <SelectValue placeholder={agents.length === 0
              ? intl.formatMessage({ id: "settings.slack.name.noAgents", defaultMessage: "No agents available" })
              : intl.formatMessage({ id: "settings.slack.name.selectAgent", defaultMessage: "Select an agent" })
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
      </FieldLabel>
    </div>
  )
}

function ManifestStep({ manifest }: { manifest: string }) {
  const intl = useIntl()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(manifest)
      setCopied(true)
    } catch {
      // Clipboard can be blocked; the textarea below is selectable as a fallback.
    }
  }

  return (
    <div className="space-y-4">
      <Step number={1} title={intl.formatMessage({ id: "settings.slack.manifest.step1.title", defaultMessage: "Copy the manifest" })}>
        <div className="relative">
          <textarea
            className="w-full h-44 px-3 py-2 text-[11px] font-mono leading-relaxed bg-muted/20 rounded-xl border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none code-scrollbar"
            value={manifest}
            readOnly
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="absolute right-2 top-2 inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-background/90 border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-status-ok" /> : <Copy className="h-3 w-3" />}
            {copied
              ? <FormattedMessage id="settings.slack.manifest.copied" defaultMessage="Copied" />
              : <FormattedMessage id="settings.slack.manifest.copy" defaultMessage="Copy" />}
          </button>
        </div>
      </Step>

      <Step number={2} title={intl.formatMessage({ id: "settings.slack.manifest.step2.title", defaultMessage: "Create the app in Slack" })}>
        <ol className="list-decimal pl-4 space-y-1.5 text-xs text-muted-foreground">
          <li>
            <FormattedMessage
              id="settings.slack.manifest.step2.a"
              defaultMessage="Open the Slack app creation page and click {createNewApp}."
              values={{ createNewApp: <span className="font-medium">Create New App</span> }}
            />
          </li>
          <li>
            <FormattedMessage
              id="settings.slack.manifest.step2.b"
              defaultMessage="Pick {fromManifest}, then choose the workspace to develop the app in."
              values={{ fromManifest: <span className="font-medium">From a manifest</span> }}
            />
          </li>
          <li>
            <FormattedMessage
              id="settings.slack.manifest.step2.c"
              defaultMessage="Switch the editor to {json}, replace its contents with the manifest above, then {next} → {create}."
              values={{
                json: <span className="font-medium">JSON</span>,
                next: <span className="font-medium">Next</span>,
                create: <span className="font-medium">Create</span>,
              }}
            />
          </li>
        </ol>
        <button
          type="button"
          onClick={() => openExternalUrl(SLACK_NEW_APP_URL)}
          className="mt-3 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-tint/15 text-tint hover:bg-tint/20 transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          <FormattedMessage id="settings.slack.manifest.openSlack" defaultMessage="Open Slack app creation page" />
        </button>
      </Step>
    </div>
  )
}

function InstallStep({
  botToken,
  appToken,
  onBotChange,
  onAppChange,
  showBot,
  showApp,
  onToggleBot,
  onToggleApp,
}: {
  botToken: string
  appToken: string
  onBotChange: (v: string) => void
  onAppChange: (v: string) => void
  showBot: boolean
  showApp: boolean
  onToggleBot: () => void
  onToggleApp: () => void
}) {
  const intl = useIntl()
  return (
    <div className="space-y-4">
      <Step number={1} title={intl.formatMessage({ id: "settings.slack.install.step1.title", defaultMessage: "Install to your workspace" })}>
        <p className="text-xs text-muted-foreground mb-2">
          <FormattedMessage
            id="settings.slack.install.step1.desc"
            defaultMessage="In your new app: {installApp} → {installToWorkspace} → {allow}. Then copy the Bot User OAuth Token (starts with {xoxb}) from {oauthPage}."
            values={{
              installApp: <span className="font-medium">Install App</span>,
              installToWorkspace: <span className="font-medium">Install to Workspace</span>,
              allow: <span className="font-medium">Allow</span>,
              xoxb: <span className="font-mono">xoxb-</span>,
              oauthPage: <span className="font-medium">OAuth &amp; Permissions</span>,
            }}
          />
        </p>
        <button
          type="button"
          onClick={() => openExternalUrl(SLACK_APPS_URL)}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-tint/15 text-tint hover:bg-tint/20 transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          <FormattedMessage id="settings.slack.install.openApps" defaultMessage="Open Your Apps" />
        </button>
        <div className="mt-3">
          <FieldLabel label={intl.formatMessage({ id: "settings.slack.install.botToken", defaultMessage: "Bot User OAuth Token" })}>
            <div className="relative">
              <input
                className={tokenCn}
                type={showBot ? "text" : "password"}
                value={botToken}
                onChange={(e) => onBotChange(e.target.value)}
                placeholder="xoxb-..."
                spellCheck={false}
                autoComplete="off"
              />
              <RevealToggle show={showBot} onToggle={onToggleBot} />
            </div>
          </FieldLabel>
        </div>
      </Step>

      <Step number={2} title={intl.formatMessage({ id: "settings.slack.install.step2.title", defaultMessage: "Generate an app-level token" })}>
        <p className="text-xs text-muted-foreground mb-2">
          <FormattedMessage
            id="settings.slack.install.step2.desc"
            defaultMessage="Open {basicInfo} → scroll to App-Level Tokens → {generate} with the {scope} scope. Copy the token (starts with {xapp})."
            values={{
              basicInfo: <span className="font-medium">Basic Information</span>,
              generate: <span className="font-medium">Generate Token and Scopes</span>,
              scope: <span className="font-mono">connections:write</span>,
              xapp: <span className="font-mono">xapp-</span>,
            }}
          />
        </p>
        <div className="mt-3">
          <FieldLabel label={intl.formatMessage({ id: "settings.slack.install.appToken", defaultMessage: "App-Level Token" })}>
            <div className="relative">
              <input
                className={tokenCn}
                type={showApp ? "text" : "password"}
                value={appToken}
                onChange={(e) => onAppChange(e.target.value)}
                placeholder="xapp-..."
                spellCheck={false}
                autoComplete="off"
              />
              <RevealToggle show={showApp} onToggle={onToggleApp} />
            </div>
          </FieldLabel>
        </div>
      </Step>
    </div>
  )
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="h-5 w-5 rounded-full bg-muted/40 text-muted-foreground flex items-center justify-center text-[10px] font-semibold">
          {number}
        </div>
        <p className="text-sm font-medium">{title}</p>
      </div>
      <div className="pl-7">{children}</div>
    </div>
  )
}

function FieldLabel({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground/60">{hint}</p>}
    </div>
  )
}

function RevealToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
    >
      {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
    </button>
  )
}
