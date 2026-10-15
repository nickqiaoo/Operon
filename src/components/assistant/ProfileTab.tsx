import type { CSSProperties } from "react"
import { Heart, Pencil } from "lucide-react"
import { defineMessages, FormattedMessage, type MessageDescriptor } from "react-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ProfileFile, ProfileFileName } from "./types"

/**
 * Card artwork. These are illustrations, not UI state colours — like a logo they
 * look the same in light and dark, so they are literal gradients rather than
 * theme tokens. A grain layer on top keeps the flat gradient from banding.
 */
const ART: Record<"soul" | "memory", CSSProperties> = {
  soul: {
    background:
      "radial-gradient(120% 90% at 90% 110%, #f43f5e 0%, transparent 55%), radial-gradient(90% 80% at 25% 30%, #9f1239 0%, transparent 70%), linear-gradient(140deg, #be123c 0%, #7f1d1d 100%)",
  },
  memory: {
    background:
      "radial-gradient(110% 90% at 15% 110%, #7dd3fc 0%, transparent 50%), radial-gradient(90% 90% at 80% 20%, #312e81 0%, transparent 70%), linear-gradient(140deg, #2563eb 0%, #1e1b4b 100%)",
  },
}

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/** Title and one-line purpose of each definition file, for its card and its editor. */
/**
 * `about`: what the file is, when the assistant reads it, who changes it and when — shown above
 * the editor as a note that is not part of the file. Keep each one true to the prompts
 * (server/src/services/assistant/prompts.ts) when those change.
 */
export const PROFILE_FILE_META: Record<ProfileFileName, { title: MessageDescriptor; about: MessageDescriptor }> = {
  identity: defineMessages({
    title: { id: "assistant.profile.identity.title", defaultMessage: "Identity" },
    about: {
      id: "assistant.profile.identity.about",
      defaultMessage:
        "How {name} introduces itself: its name, what it calls you, and a line on what it is for. {name} always keeps it in mind. It fills in the names when you first meet and changes them when you ask. You can edit it at any time; edits take effect from your next message.",
    },
  }),
  soul: defineMessages({
    title: { id: "assistant.profile.soul.title", defaultMessage: "Soul" },
    about: {
      id: "assistant.profile.soul.about",
      defaultMessage:
        "{name}'s character: the habits and tone it always keeps to. It starts from a template that ships with operon, and {name} changes it only when you ask. You can edit it at any time; edits take effect from your next message. Preferences you mention along the way (\"keep it short\") go to Memory instead.",
    },
  }),
  memory: defineMessages({
    title: { id: "assistant.profile.memory.title", defaultMessage: "Memory" },
    about: {
      id: "assistant.profile.memory.about",
      defaultMessage:
        "What {name} knows about you for the long run: facts, the people in your life, your preferences, and your own matters it follows up on (In progress). {name} always keeps it in mind and updates it as things come up; the day's details go to its daily notes, and once a day it tidies this file. It reflects {name}'s understanding and can be out of date. Edit anything here (it sees your edits with your next message), or ask {name} to forget something.",
    },
  }),
  heartbeat: defineMessages({
    title: { id: "assistant.profile.checklist.title", defaultMessage: "Checklist" },
    about: {
      id: "assistant.profile.checklist.about",
      defaultMessage:
        "What the background check looks at every 30 minutes: one section per service, with the tool to call and what is worth telling you. Nothing else is checked. {name} adds a section when you ask it to watch for something; you can add or change them here too.",
    },
  }),
}

const TAGLINES = defineMessages({
  careful: { id: "assistant.profile.tagline.careful", defaultMessage: "Handle with care" },
})

const PROFILE_CARDS: { name: "soul" | "memory"; tagline: MessageDescriptor }[] = [
  { name: "soul", tagline: TAGLINES.careful },
  { name: "memory", tagline: TAGLINES.careful },
]

interface ProfileTabProps {
  files: ProfileFile[]
  assistantName: string
  onOpenFile: (name: ProfileFileName) => void
}

/** Who the assistant is, and the files that make it so. Every file opens in the editor drawer. */
export function ProfileTab({ files, assistantName, onOpenFile }: ProfileTabProps) {
  const updatedAt = (name: ProfileFileName) => files.find((f) => f.name === name)?.updatedAt ?? Date.now()

  return (
    <div className="space-y-3 px-3 pb-4 pt-2">
      <div className="space-y-3 rounded-xl border border-border/40 bg-muted/30 p-4">
        <div className="text-base font-semibold">{assistantName}</div>
        <Button size="sm" variant="secondary" className="h-8 w-full gap-1.5" onClick={() => onOpenFile("identity")}>
          <Pencil className="h-3.5 w-3.5" />
          <FormattedMessage id="assistant.profile.edit" defaultMessage="Edit" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {PROFILE_CARDS.map((c) => (
          <FileCard key={c.name} card={c} updatedAt={updatedAt(c.name)} onOpen={() => onOpenFile(c.name)} />
        ))}
      </div>
    </div>
  )
}

function FileCard({
  card,
  updatedAt,
  onOpen,
}: {
  card: (typeof PROFILE_CARDS)[number]
  updatedAt: number
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={ART[card.name]}
      className={cn(
        "group relative flex w-full flex-col justify-between overflow-hidden rounded-xl p-4 text-left text-white shadow-card transition-[filter,transform] duration-200",
        "hover:brightness-110 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "aspect-[1.1]",
      )}
    >
      <span className="pointer-events-none absolute inset-0 opacity-30 mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
      <span className="relative">
        <span className="block text-lg font-semibold uppercase tracking-wide">
          <FormattedMessage {...PROFILE_FILE_META[card.name].title} />
        </span>
        <span className="block text-xs text-white/75">
          <FormattedMessage {...card.tagline} />
        </span>
      </span>
      <span className="relative flex items-end justify-between">
        <span className="text-sm tabular-nums text-white/85">{formatCardDate(updatedAt)}</span>
        <Heart className="h-5 w-5 fill-white/70 text-white/0" />
      </span>
    </button>
  )
}

/** "09.29.26" — the date the file last changed. */
function formatCardDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}.${String(d.getFullYear()).slice(2)}`
}
