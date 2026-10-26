import type { ReactNode } from "react"
import { Pencil } from "lucide-react"
import { defineMessages, FormattedMessage, type MessageDescriptor } from "react-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ProfileFile, ProfileFileName } from "./types"

/**
 * Card artwork. These are illustrations, not UI state colours — like a logo they
 * look the same in light and dark, so they are literal colours rather than theme
 * tokens. A flat ground with a line drawing on it: Soul's ripples spreading from
 * a corner (a temperament carried outward), Memory's dot field with a few points
 * joined into a constellation (facts it has linked up).
 */
const ART: Record<"soul" | "memory", { ground: string; motif: ReactNode }> = {
  soul: {
    ground: "#4338a0",
    motif: (
      <g fill="none" stroke="white" strokeWidth="1">
        {[40, 56, 72, 88, 104, 120].map((r, i) => (
          <circle key={r} cx="180" cy="175" r={r} strokeOpacity={0.45 - i * 0.06} />
        ))}
      </g>
    ),
  },
  memory: {
    ground: "#2f3a4a",
    motif: (
      <>
        <g fill="white" fillOpacity="0.16">
          {Array.from({ length: 8 }, (_, row) =>
            Array.from({ length: 8 }, (_, col) => <circle key={`${row}-${col}`} cx={10 + col * 20} cy={10 + row * 20} r="1" />),
          )}
        </g>
        <polyline points="102,34 128,20 148,50 122,74 142,98 116,124 146,144" fill="none" stroke="white" strokeOpacity="0.45" strokeWidth="1" />
        <line x1="128" y1="20" x2="122" y2="74" stroke="white" strokeOpacity="0.25" strokeWidth="1" />
        <g fill="white">
          {[[102, 34], [128, 20], [148, 50], [122, 74], [142, 98], [116, 124], [146, 144]].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.5" fillOpacity="0.85" />
          ))}
        </g>
      </>
    ),
  },
}

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
        "What the background check looks at every 30 minutes: one section per service, with the tool to call and what is worth telling you. Nothing else is checked. {name} adds a section when you ask it to watch for something; you can add or change them here too. The last section, Already told, is the check's own record of what you have heard and is still going on, so it doesn't tell you twice: delete a line there and you may hear about it again.",
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
      style={{ background: ART[card.name].ground }}
      className={cn(
        "group relative flex w-full flex-col justify-between overflow-hidden rounded-xl p-4 text-left text-white shadow-card transition-[filter,transform] duration-200",
        "hover:brightness-110 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "aspect-[1.1]",
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 160 160"
        preserveAspectRatio="xMaxYMax slice"
        className="pointer-events-none absolute inset-0 h-full w-full transition-transform duration-300 group-hover:scale-[1.03]"
      >
        {ART[card.name].motif}
      </svg>
      <span className="relative">
        <span className="block text-lg font-semibold uppercase tracking-wide">
          <FormattedMessage {...PROFILE_FILE_META[card.name].title} />
        </span>
        <span className="block text-xs text-white/75">
          <FormattedMessage {...card.tagline} />
        </span>
      </span>
      <span className="relative text-sm tabular-nums text-white/85">{formatCardDate(updatedAt)}</span>
    </button>
  )
}

/** "09.29.26" — the date the file last changed. */
function formatCardDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}.${String(d.getFullYear()).slice(2)}`
}
