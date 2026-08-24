import { Loader2, Save, Check, AlertCircle } from "lucide-react"
import { FormattedMessage } from "react-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useConfigEditor, type ConfigFileDefinition } from "./useConfigEditor"

interface ConfigEditorProps<T extends string> {
    configDir: string
    files: ConfigFileDefinition<T>[]
}

export function ConfigEditor<T extends string>({ configDir, files }: ConfigEditorProps<T>) {
    const {
        activeFile,
        setActiveFile,
        homePath,
        getFilePath,
        currentFile,
        currentFileDef,
        hasChanges,
        handleContentChange,
        handleSave,
    } = useConfigEditor({ configDir, files })

    const validationType = currentFileDef?.validation ?? "none"
    const validationLabel = validationType === "json" ? "JSON" : validationType === "toml" ? "TOML" : null

    return (
        <div className="space-y-6">
            {/* File Tabs */}
            <div className="flex items-center p-1 bg-muted/30 rounded-xl border border-border/60 w-fit">
                {files.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setActiveFile(id)}
                        className={cn(
                            "flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg transition-all duration-200 ease-out",
                            activeFile === id
                                ? "bg-background text-foreground shadow-premium"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                    </button>
                ))}
            </div>

            {/* File Path Display */}
            <div className="text-xs text-muted-foreground font-mono px-1">
                {homePath ? getFilePath(currentFileDef?.filename || "") : <FormattedMessage id="common.loading" defaultMessage="Loading…" />}
            </div>

            {/* Editor */}
            <div className="relative group">
                {currentFile.loading ? (
                    <div className="flex items-center justify-center h-96 bg-muted/20 rounded-2xl border border-border/60">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                ) : currentFile.error ? (
                    <div className="flex items-center justify-center h-96 bg-destructive/5 rounded-2xl border border-destructive/10">
                        <div className="flex items-center gap-2 text-destructive">
                            <AlertCircle className="h-5 w-5" />
                            <span className="text-sm">{currentFile.error}</span>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="absolute inset-0 bg-muted/20 rounded-2xl pointer-events-none transition-opacity duration-300 group-focus-within:opacity-0" />
                        <textarea
                            value={currentFile.content}
                            onChange={(e) => handleContentChange(activeFile, e.target.value)}
                            className={cn(
                                "w-full h-96 p-6 bg-transparent rounded-2xl border border-border/60 code-scrollbar relative z-10",
                                "font-mono text-sm resize-none shadow-card transition-all duration-300",
                                "focus:outline-none focus:ring-4 focus:ring-primary/10 focus:border-border focus:bg-background/50 focus:shadow-premium",
                                "placeholder:text-muted-foreground/40",
                                currentFile.validationError
                                    ? "border-destructive/30 focus:ring-destructive/10"
                                    : ""
                            )}
                            placeholder={currentFileDef?.placeholder ?? "{}"}
                            spellCheck={false}
                        />
                        {currentFile.validationError && (
                            <div className="mt-2 flex items-start gap-2 text-destructive text-xs">
                                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                <span className="font-mono">{currentFile.validationError}</span>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                    {currentFileDef?.description}
                </div>
                <div className="flex items-center gap-2">
                    {currentFile.validationError && validationLabel && (
                        <span className="text-xs text-destructive"><FormattedMessage id="settings.config.invalid" defaultMessage="Invalid {type}" values={{ type: validationLabel }} /></span>
                    )}
                    {!currentFile.validationError && validationLabel && currentFile.content.trim() && (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                            <Check className="h-3.5 w-3.5" />
                            <FormattedMessage id="settings.config.valid" defaultMessage="Valid {type}" values={{ type: validationLabel }} />
                        </span>
                    )}
                    {currentFile.saved && (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                            <Check className="h-3.5 w-3.5" />
                            <FormattedMessage id="common.saved" defaultMessage="Saved" />
                        </span>
                    )}
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleSave(activeFile)}
                        disabled={currentFile.saving || currentFile.loading || !hasChanges || !!currentFile.validationError}
                        className="gap-1.5"
                    >
                        {currentFile.saving ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Save className="h-3.5 w-3.5" />
                        )}
                        <FormattedMessage id="common.save" defaultMessage="Save" />
                    </Button>
                </div>
            </div>
        </div>
    )
}
