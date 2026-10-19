import { FormattedMessage } from "react-intl"


export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) {
    return <span className="text-muted-foreground"><FormattedMessage id="review.diffStats.noChanges" defaultMessage="no changes" /></span>
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
      {additions > 0 && (
        <span className="text-diff-add">+{additions.toLocaleString()}</span>
      )}
      {deletions > 0 && (
        <span className="text-diff-remove">-{deletions.toLocaleString()}</span>
      )}
    </span>
  )
}

/**
 * Branch-scope selector: `head → base ▾`. The base is a searchable dropdown of
 * local + remote branches; picking one re-diffs HEAD against its merge-base.
 */
