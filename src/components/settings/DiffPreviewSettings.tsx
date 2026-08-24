import { useState, useEffect } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Loader2, Save, Check, AlertCircle, Eye, EyeOff, FileDiff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { openExternalUrl } from "@/lib/open-external"

export function DiffPreviewSettings() {
    const intl = useIntl()
    const [workerUrl, setWorkerUrl] = useState("")
    const [workerApiKey, setWorkerApiKey] = useState("")
    const [showKey, setShowKey] = useState(false)

    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [savedOk, setSavedOk] = useState(false)
    const [saveErr, setSaveErr] = useState(false)

    useEffect(() => {
        api.diffPreviewGetConfig().then((res) => {
            setWorkerUrl(res.workerUrl ?? "")
            setWorkerApiKey(res.workerApiKey ?? "")
        }).catch(() => {
            // ignore
        }).finally(() => setLoading(false))
    }, [])

    async function handleSave() {
        setSaving(true); setSavedOk(false); setSaveErr(false)
        try {
            await api.diffPreviewSaveConfig({
                workerUrl: workerUrl.trim(),
                workerApiKey: workerApiKey.trim(),
            })
            setSavedOk(true)
            setTimeout(() => setSavedOk(false), 2000)
        } catch {
            setSaveErr(true)
            setTimeout(() => setSaveErr(false), 2000)
        } finally {
            setSaving(false)
        }
    }

    const inputCn = "w-full px-3 py-2 text-sm font-mono bg-background/80 rounded-xl border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40"

    return (
        <section className="space-y-5 rounded-xl border border-border/40 bg-muted/10 p-5">
            <div className="flex items-start gap-3">
                <FileDiff className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                    <h2 className="text-sm font-semibold mb-1"><FormattedMessage id="settings.diffPreview.title" defaultMessage="Diff Preview" /></h2>
                    <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.diffPreview.desc"
                            defaultMessage="Shared across all IM providers. Deploy the Cloudflare Worker from <link>operon-diff-worker</link>. Telegram will render the link as a mini app; Slack and others receive a plain link button."
                            values={{
                                link: (chunks) => (
                                    <button
                                        type="button"
                                        onClick={() => openExternalUrl("https://github.com/Nickqiaoo/operon-diff-worker")}
                                        className="text-primary hover:underline cursor-pointer"
                                    >
                                        {chunks}
                                    </button>
                                ),
                            }}
                        />
                    </p>
                </div>
            </div>

            {loading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> <FormattedMessage id="common.loading" defaultMessage="Loading…" />
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground"><FormattedMessage id="settings.diffPreview.workerUrl" defaultMessage="Worker URL" /></label>
                        <input
                            type="text"
                            value={workerUrl}
                            onChange={e => setWorkerUrl(e.target.value)}
                            placeholder="https://operon-diff-viewer.your-account.workers.dev"
                            className={inputCn}
                            spellCheck={false}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground"><FormattedMessage id="settings.diffPreview.apiKey" defaultMessage="Worker API Key" /></label>
                        <div className="relative">
                            <input
                                type={showKey ? "text" : "password"}
                                value={workerApiKey}
                                onChange={e => setWorkerApiKey(e.target.value)}
                                placeholder={intl.formatMessage({ id: "settings.diffPreview.apiKeyPlaceholder", defaultMessage: "Secret key for authenticating diff uploads" })}
                                className={inputCn + " pr-10"}
                                spellCheck={false}
                                autoComplete="off"
                            />
                            <button
                                type="button"
                                onClick={() => setShowKey(!showKey)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <Button size="sm" variant="secondary" onClick={handleSave} disabled={saving} className="h-8 gap-1.5">
                            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            <Save className="h-3.5 w-3.5" />
                            <FormattedMessage id="common.save" defaultMessage="Save" />
                        </Button>
                        {savedOk && <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><Check className="h-3.5 w-3.5" /> <FormattedMessage id="common.saved" defaultMessage="Saved" /></span>}
                        {saveErr && <span className="flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> <FormattedMessage id="common.saveFailed" defaultMessage="Failed to save" /></span>}
                    </div>
                </div>
            )}
        </section>
    )
}
