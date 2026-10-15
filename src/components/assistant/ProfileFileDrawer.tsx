import { useEffect, useState } from "react"
import { Save, X } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ProfileFile, ProfileFileName } from "./types"
import { timeAgo } from "./assistant-i18n"
import { DrawerShell, useDrawer } from "./Drawer"
import { PROFILE_FILE_META } from "./ProfileTab"

interface ProfileFileDrawerProps {
  /** The file to edit, or null when closed. */
  file: ProfileFile | null
  assistantName: string
  onClose: () => void
  onSave: (name: ProfileFileName, content: string) => void
}

/** One definition file opened for editing, as raw markdown. */
export function ProfileFileDrawer({ file, assistantName, onClose, onSave }: ProfileFileDrawerProps) {
  const { shown, active } = useDrawer(file, onClose)
  if (!shown) return null
  return (
    <DrawerShell active={active}>
      <ProfileFileEditor file={shown} assistantName={assistantName} onClose={onClose} onSave={onSave} />
    </DrawerShell>
  )
}

interface ProfileFileEditorProps {
  file: ProfileFile
  assistantName: string
  /** Shows a close button in the header. */
  onClose?: () => void
  onSave: (name: ProfileFileName, content: string) => void
  /** Phone layout: tighter gutters and a 16px textarea, so iOS doesn't zoom in on focus. */
  compact?: boolean
}

/** The editor itself: what the file is, the markdown, Revert / Save. */
export function ProfileFileEditor({ file, assistantName, onClose, onSave, compact }: ProfileFileEditorProps) {
  const intl = useIntl()
  const [draft, setDraft] = useState(file.content)

  // Opening another file — or the assistant rewriting this one — resets the draft.
  useEffect(() => {
    setDraft(file.content)
  }, [file.name, file.content])

  const meta = PROFILE_FILE_META[file.name]
  const dirty = draft !== file.content

  return (
    <>
      <div className={cn("flex items-start gap-3 border-b border-border/40 py-4", compact ? "px-4" : "px-5")}>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">
            <FormattedMessage {...meta.title} />
          </div>
          <div className="mt-0.5 break-all text-xs text-muted-foreground">
            <span className="font-mono">~/.operon/assistant/{file.name}.md</span>
            {" · "}
            {file.updatedBy === "assistant" ? (
              <FormattedMessage
                id="assistant.profile.updatedBy"
                defaultMessage="updated by {name} {when}"
                values={{ name: assistantName, when: timeAgo(intl, file.updatedAt) }}
              />
            ) : (
              <FormattedMessage
                id="assistant.profile.editedByYou"
                defaultMessage="edited by you {when}"
                values={{ when: timeAgo(intl, file.updatedAt) }}
              />
            )}
          </div>
          {/* What the file is and who changes it — a note above the file, not part of it. */}
          <div className="mt-3 border-l-2 border-border/60 pl-3 text-xs leading-relaxed text-muted-foreground dark:border-border/35">
            <FormattedMessage
              id="assistant.profile.aboutLead"
              defaultMessage="<b>About this file.</b> {about}"
              values={{
                b: (chunks) => <span className="font-medium text-foreground/80">{chunks}</span>,
                about: <FormattedMessage {...meta.about} values={{ name: assistantName }} />,
              }}
            />
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={intl.formatMessage({ id: "assistant.close", defaultMessage: "Close" })}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className={cn(
          "min-h-0 flex-1 resize-none bg-transparent py-4 font-mono leading-relaxed text-foreground/90 outline-none",
          compact ? "px-4 text-base" : "px-5 text-xs",
        )}
      />

      <div className="flex items-center justify-end gap-1.5 border-t border-border/40 px-4 py-3">
        <Button size="sm" variant="ghost" className="h-8" disabled={!dirty} onClick={() => setDraft(file.content)}>
          <FormattedMessage id="assistant.profile.revert" defaultMessage="Revert" />
        </Button>
        <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!dirty} onClick={() => onSave(file.name, draft)}>
          <Save className="h-3.5 w-3.5" />
          <FormattedMessage id="assistant.profile.save" defaultMessage="Save" />
        </Button>
      </div>
    </>
  )
}
