import { useIntl } from "react-intl"
import type { DiffScope } from "./types"
import { EMPTY_HINT, EMPTY_TITLE } from "./constants"

export function EmptyState({ scope }: { scope: DiffScope }) {
  const intl = useIntl()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4">
      <div className="text-sm font-medium">{intl.formatMessage(EMPTY_TITLE[scope])}</div>
      <div className="text-xs text-muted-foreground">{intl.formatMessage(EMPTY_HINT[scope])}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------

