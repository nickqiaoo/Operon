import { useRef, type HTMLAttributes, type ReactNode } from 'react'
import { useIntl } from 'react-intl'
import { ImagePlus, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The one bordered, lifted box both channel composers (main + thread) sit in.
 * Keeping the frame in one place is what stops the two inputs drifting apart
 * again (they used to differ in radius, border alpha, shadow and send button).
 * `relative` stays on the frame so an absolutely positioned MentionPicker can
 * anchor to it.
 */
type ComposerFrameProps = Pick<HTMLAttributes<HTMLDivElement>, 'onPaste' | 'onDragOver' | 'onDrop'> & {
  className?: string
  floating?: boolean
  children: ReactNode
}

export function ComposerFrame({ className, floating = false, children, ...imageEvents }: ComposerFrameProps) {
  return (
    <div
      {...imageEvents}
      className={cn(
        'relative flex items-end gap-2 rounded-xl px-3 py-2.5',
        // Floating (phone): frosted over the transcript scrolling under it; the
        // glass brings its own tint, rim and lift.
        floating
          ? 'liquid-glass'
          : 'border border-border/60 bg-popover/90 shadow-input dark:border-border/35 dark:bg-popover/85',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Shared textarea classes: same line-height and min-height in both composers. */
export const COMPOSER_TEXTAREA_CLASS =
  'flex-1 bg-transparent text-sm leading-6 resize-none outline-none text-foreground placeholder:text-muted-foreground/40 max-h-40 min-h-[2.25rem] overflow-y-auto py-1'

/** Pick images from disk; pasting or dropping them into the input works too. */
export function ComposerAttachButton({ onFiles, disabled = false }: { onFiles: (files: FileList | null) => void; disabled?: boolean }) {
  const intl = useIntl()
  const inputRef = useRef<HTMLInputElement>(null)
  const label = intl.formatMessage({ id: 'channel.composer.attachImage', defaultMessage: 'Attach image' })
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onFiles(e.target.files)
          // Picking the same file again must fire onChange again.
          e.target.value = ''
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title={label}
        aria-label={label}
        className="size-9 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ImagePlus className="size-4" />
      </Button>
    </>
  )
}

export function ComposerSendButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const intl = useIntl()
  const label = intl.formatMessage({ id: 'common.send', defaultMessage: 'Send' })
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="size-9 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
    >
      <Send className="size-4" />
    </Button>
  )
}
