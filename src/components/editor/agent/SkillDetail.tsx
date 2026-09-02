import { useEffect, useMemo, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { ArrowLeft, CornerDownLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { api } from '@/lib/api'
import type { OperonSkillDTO } from './agentControl'

/**
 * One skill, read out in full — the panel's second layer.
 *
 * The list row can only ever show a truncated description, which is the worst of both
 * worlds: unreadable AND a whole line wide. The thing a reader actually wants is the
 * skill's own file, so this reads it and renders it, in place. Staying inside the panel
 * (rather than opening the file in the editor) is the point: you are looking this up
 * WHILE the agent works, and losing your place in the transcript to do it is the cost
 * that stops people from looking at all.
 *
 * `Open file` is still offered for skills that live in the workspace, where the editor
 * gives you search and the surrounding directory.
 */
/**
 * Strip a SKILL.md's YAML front matter and HTML comments.
 *
 * Front matter is not prose, and markdown does not treat it as data: the closing `---`
 * turns the line above it into a setext heading, so `name:` / `description:` render as
 * one enormous bold paragraph — the loudest thing on the page, saying what the title bar
 * already says. The description is worth keeping, but as a subtitle, not as an H1.
 */
function splitFrontMatter(raw: string): { description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const body = (match ? raw.slice(match[0].length) : raw)
    // Marker comments (`<!-- OPERON_MANAGED_… -->`) are plumbing for the loader.
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  const description = match ? /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim() : undefined
  return { ...(description ? { description } : {}), body }
}

export function SkillDetail({
  skill,
  onBack,
  onUse,
}: {
  skill: OperonSkillDTO
  onBack: () => void
  /** Hand this skill to the composer as a chip. */
  onUse: () => void
}) {
  const intl = useIntl()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const parsed = useMemo(() => (content == null ? null : splitFrontMatter(content)), [content])

  useEffect(() => {
    if (!skill.path) {
      setError(intl.formatMessage({ id: 'editor.skill.noPath', defaultMessage: 'This skill does not report a file path.' }))
      return
    }
    let cancelled = false
    setContent(null)
    setError(null)
    api
      .readFile(skill.path)
      .then((text) => {
        if (!cancelled) setContent(text)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [skill.path, intl])


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-3.5 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <FormattedMessage id="editor.session.skills" defaultMessage="Skills" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium">/{skill.name}</span>
      </div>

      <div className="flex items-center gap-1.5 border-b border-border/40 px-3.5 py-2">
        <Button size="sm" variant="secondary" className="h-7 gap-1.5 text-xs" onClick={onUse}>
          <CornerDownLeft className="h-3.5 w-3.5" />
          <FormattedMessage id="editor.skill.use" defaultMessage="Use skill" />
        </Button>
        {/* No "Open file": the file is what you are already looking at. */}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{skill.source}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {error ? (
          <div className="text-xs text-status-error">{error}</div>
        ) : content == null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />{' '}
            <FormattedMessage id="common.loading" defaultMessage="Loading…" />
          </div>
        ) : (
          <>
            {parsed?.description && (
              <p className="mb-3 border-b border-border/40 pb-3 text-xs leading-relaxed text-muted-foreground">
                {parsed.description}
              </p>
            )}
            {/* Headings step down a size: this is a 400px column, and a document H1 at
                its normal size dwarfs the panel it is sitting in. Descendant selectors
                rather than `prose-h1:` modifiers — the renderer already sets those, and
                two `prose-h1:text-*` classes do not resolve by source order the way a
                plain conflict would. `.x h1` outranks the plugin's `:where(h1)`, which
                carries no specificity at all. */}
            <MarkdownRenderer
              content={parsed?.body ?? ''}
              className="text-[13px] [&_h1]:text-sm [&_h2]:text-[13px] [&_h3]:text-[13px] [&_h4]:text-[13px] [&_h1]:mt-4 [&_h2]:mt-4 [&_p]:text-[13px] [&_li]:text-[13px] [&_pre]:text-xs [&_code]:text-xs"
            />
          </>
        )}
      </div>
    </div>
  )
}
