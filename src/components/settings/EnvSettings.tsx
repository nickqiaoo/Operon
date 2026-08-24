import { useState, useEffect } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Loader2, Save, Check, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

export function EnvSettings() {
    const intl = useIntl()
    const [vars, setVars] = useState<Array<{ key: string; value: string }>>([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [savedOk, setSavedOk] = useState(false)
    const [saveErr, setSaveErr] = useState(false)

    useEffect(() => {
        api.envGetAll().then((res) => {
            const entries = Object.entries(res.vars ?? {}).map(([key, value]) => ({ key, value }))
            setVars(entries.length > 0 ? entries : [{ key: '', value: '' }])
        }).catch(() => {
            setVars([{ key: '', value: '' }])
        }).finally(() => setLoading(false))
    }, [])

    function updateRow(index: number, field: 'key' | 'value', val: string) {
        setVars(prev => prev.map((r, i) => i === index ? { ...r, [field]: val } : r))
    }

    function addRow() {
        setVars(prev => [...prev, { key: '', value: '' }])
    }

    function removeRow(index: number) {
        setVars(prev => prev.length === 1 ? [{ key: '', value: '' }] : prev.filter((_, i) => i !== index))
    }

    async function handleSave() {
        setSaving(true); setSavedOk(false); setSaveErr(false)
        try {
            const record: Record<string, string> = {}
            for (const { key, value } of vars) {
                if (key.trim()) record[key.trim()] = value
            }
            await api.envSave(record)
            setSavedOk(true)
            setTimeout(() => setSavedOk(false), 2000)
        } catch {
            setSaveErr(true)
            setTimeout(() => setSaveErr(false), 2000)
        } finally {
            setSaving(false)
        }
    }

    const inputCn = 'flex-1 px-3 py-2 text-sm font-mono bg-background/80 rounded-xl border border-border/60 focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40'

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-sm font-semibold mb-1"><FormattedMessage id="channel.form.envVars" defaultMessage="Environment Variables" /></h2>
                <p className="text-xs text-muted-foreground">
                    <FormattedMessage id="settings.env.desc" defaultMessage="These variables are applied to the server process and inherited by all AI adapters (Claude Code, Codex, OpenCode, etc.). Useful for proxy settings, custom API endpoints, TLS overrides, or any environment-level configuration." />
                </p>
            </div>

            {loading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> <FormattedMessage id="common.loading" defaultMessage="Loading…" />
                </div>
            ) : (
                <div className="space-y-2">
                    {vars.map((row, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <input
                                type="text"
                                value={row.key}
                                onChange={e => updateRow(i, 'key', e.target.value)}
                                placeholder={intl.formatMessage({ id: 'channel.form.envKeyPlaceholder', defaultMessage: 'KEY' })}
                                className={inputCn}
                                spellCheck={false}
                            />
                            <span className="text-muted-foreground text-sm">=</span>
                            <input
                                type="text"
                                value={row.value}
                                onChange={e => updateRow(i, 'value', e.target.value)}
                                placeholder={intl.formatMessage({ id: 'channel.form.envValuePlaceholder', defaultMessage: 'value' })}
                                className={inputCn}
                                spellCheck={false}
                            />
                            <button
                                type="button"
                                onClick={() => removeRow(i)}
                                className="text-muted-foreground hover:text-destructive transition-colors p-1"
                                title={intl.formatMessage({ id: 'common.remove', defaultMessage: 'Remove' })}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        </div>
                    ))}

                    <button
                        type="button"
                        onClick={addRow}
                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 mt-1 transition-colors"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        <FormattedMessage id="channel.form.addVariable" defaultMessage="Add variable" />
                    </button>
                </div>
            )}

            <div className="flex items-center gap-3 pt-2">
                <Button data-testid="settings-env-save" size="sm" variant="secondary" onClick={handleSave} disabled={saving || loading} className="h-8 gap-1.5">
                    {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <Save className="h-3.5 w-3.5" />
                    <FormattedMessage id="common.save" defaultMessage="Save" />
                </Button>
                {savedOk && <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><Check className="h-3.5 w-3.5" /> <FormattedMessage id="common.saved" defaultMessage="Saved" /></span>}
                {saveErr && <span className="flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> <FormattedMessage id="common.saveFailed" defaultMessage="Failed to save" /></span>}
            </div>
        </div>
    )
}
