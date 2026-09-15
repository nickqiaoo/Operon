import { forwardRef, type ReactNode } from "react"
import { useIntl } from "react-intl"
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { FindOptions, TextFindState } from "./useTextFind"

interface FindBarProps {
  query: string
  onQueryChange: (query: string) => void
  options: FindOptions
  onOptionsChange: (options: FindOptions) => void
  find: TextFindState
  onClose: () => void
}

/**
 * Floating find widget for the file preview: query, match-case / whole-word /
 * regex toggles, "3 of 12", previous / next and close. Enter and Shift+Enter
 * step through matches, Escape closes.
 */
export const FindBar = forwardRef<HTMLInputElement, FindBarProps>(function FindBar(
  { query, onQueryChange, options, onOptionsChange, find, onClose },
  inputRef
) {
  const intl = useIntl()
  const hasQuery = query.length > 0
  const status = !hasQuery
    ? null
    : find.error != null
      ? intl.formatMessage({ id: "filePreview.find.invalid", defaultMessage: "Invalid pattern" })
      : find.count === 0
        ? intl.formatMessage({ id: "filePreview.find.noResults", defaultMessage: "No results" })
        : intl.formatMessage(
            { id: "filePreview.find.position", defaultMessage: "{current} of {total}" },
            { current: find.index + 1, total: find.truncated ? `${find.count}+` : find.count }
          )

  return (
    <div
      role="search"
      className="absolute right-4 top-2 z-20 flex max-w-[calc(100%-2rem)] items-center gap-1 rounded-lg border border-border/60 bg-popover p-1 shadow-float dark:border-border/35"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        className={cn(
          "flex h-7 min-w-0 items-center rounded-md border bg-background pl-2 pr-0.5",
          find.error != null
            ? "border-status-error/60"
            : "border-border/50 focus-within:border-ring dark:border-border/35"
        )}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return
            e.preventDefault()
            if (e.shiftKey) find.previous()
            else find.next()
          }}
          placeholder={intl.formatMessage({ id: "filePreview.find.placeholder", defaultMessage: "Find" })}
          aria-label={intl.formatMessage({ id: "filePreview.find.placeholder", defaultMessage: "Find" })}
          title={find.error ?? undefined}
          spellCheck={false}
          className="h-full w-40 min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        <OptionToggle
          active={options.caseSensitive}
          label={intl.formatMessage({ id: "filePreview.find.matchCase", defaultMessage: "Match case" })}
          onClick={() => onOptionsChange({ ...options, caseSensitive: !options.caseSensitive })}
        >
          <CaseSensitive className="h-3.5 w-3.5" />
        </OptionToggle>
        <OptionToggle
          active={options.wholeWord}
          label={intl.formatMessage({ id: "filePreview.find.wholeWord", defaultMessage: "Match whole word" })}
          onClick={() => onOptionsChange({ ...options, wholeWord: !options.wholeWord })}
        >
          <WholeWord className="h-3.5 w-3.5" />
        </OptionToggle>
        <OptionToggle
          active={options.regex}
          label={intl.formatMessage({ id: "filePreview.find.regex", defaultMessage: "Use regular expression" })}
          onClick={() => onOptionsChange({ ...options, regex: !options.regex })}
        >
          <Regex className="h-3.5 w-3.5" />
        </OptionToggle>
      </div>
      <span
        aria-live="polite"
        className={cn(
          "min-w-[4.5rem] shrink-0 px-1.5 text-xs tabular-nums",
          find.error != null ? "text-status-error" : "text-muted-foreground"
        )}
      >
        {status}
      </span>
      <IconButton
        label={intl.formatMessage({ id: "filePreview.find.previous", defaultMessage: "Previous match" })}
        disabled={find.count === 0}
        onClick={find.previous}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        label={intl.formatMessage({ id: "filePreview.find.next", defaultMessage: "Next match" })}
        disabled={find.count === 0}
        onClick={find.next}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        label={intl.formatMessage({ id: "filePreview.find.close", defaultMessage: "Close" })}
        onClick={onClose}
      >
        <X className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  )
})

function OptionToggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      // Keep focus in the input so typing continues after flipping an option.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded transition-colors",
        active
          ? "bg-secondary-active text-foreground"
          : "text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}
