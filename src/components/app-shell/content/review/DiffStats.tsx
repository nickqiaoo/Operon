
export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) {
    return <span className="text-muted-foreground">no changes</span>
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
      {additions > 0 && (
        <span className="text-[#3f9348] dark:text-[#4cae4f]">+{additions.toLocaleString()}</span>
      )}
      {deletions > 0 && (
        <span className="text-[#c84d4d] dark:text-[#d1493f]">-{deletions.toLocaleString()}</span>
      )}
    </span>
  )
}

/**
 * Branch-scope selector: `head → base ▾`. The base is a searchable dropdown of
 * local + remote branches; picking one re-diffs HEAD against its merge-base.
 */
