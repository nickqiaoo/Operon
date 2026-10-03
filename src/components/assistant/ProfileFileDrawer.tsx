import { useEffect, useState } from "react"
import { Save, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ProfileFile, ProfileFileName } from "./types"
import { timeAgo } from "./shared"
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
  const [draft, setDraft] = useState(file?.content ?? "")

  // Opening another file — or the assistant rewriting this one — resets the draft.
  useEffect(() => {
    if (file) setDraft(file.content)
  }, [file?.name, file?.content])

  if (!shown) return null
  const meta = PROFILE_FILE_META[shown.name]
  const dirty = draft !== shown.content

  return (
    <DrawerShell active={active}>
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{meta.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-mono">~/.operon/assistant/{shown.name}.md</span>
            {" · "}
            {shown.updatedBy === "assistant" ? `updated by ${assistantName}` : "edited by you"} {timeAgo(shown.updatedAt)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">{meta.hint}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 font-mono text-xs leading-relaxed text-foreground/90 outline-none"
      />

      <div className="flex items-center justify-end gap-1.5 border-t border-border/40 px-4 py-3">
        <Button size="sm" variant="ghost" className="h-8" disabled={!dirty} onClick={() => setDraft(shown.content)}>
          Revert
        </Button>
        <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!dirty} onClick={() => onSave(shown.name, draft)}>
          <Save className="h-3.5 w-3.5" />
          Save
        </Button>
      </div>
    </DrawerShell>
  )
}
